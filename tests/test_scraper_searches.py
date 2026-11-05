"""Pruebas de la lista de busquedas del scraper y de como recorre cada una.

Usan un sitio simulado (sin red). Se ejecutan desde la raiz del repo:
    python -X utf8 -m unittest discover -s tests -t .
"""

import csv
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src.scraper import fincaraiz_scraper as scraper


def page_html(items, last_page, total):
    data = {"props": {"pageProps": {"fetchResult": {"searchFast": {
        "data": items, "paginatorInfo": {"lastPage": last_page, "total": total},
    }}}}}
    return f'<html><body><script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script></body></html>'


def item(n):
    return {"id": n, "title": f"anuncio {n}", "property_type": {"name": "Apartamento"}}


class ConfigTests(unittest.TestCase):
    def test_routes_are_unique_and_well_formed(self):
        routes = [e[0] for e in scraper.LOCATIONS]
        self.assertEqual(len(routes), len(set(routes)), "hay rutas repetidas")
        for r in routes:
            self.assertRegex(r, r"^[a-z0-9\-]+(/[a-z0-9\-]+)?$")

    def test_resto_de_colombia_is_gone(self):
        self.assertNotIn("resto-de-colombia", [e[0] for e in scraper.LOCATIONS])

    def test_bogota_and_antioquia_are_split(self):
        routes = {e[0] for e in scraper.LOCATIONS}
        self.assertNotIn("bogota-dc", routes)
        self.assertNotIn("antioquia", routes)
        self.assertEqual(len([r for r in routes if r.endswith("/bogota")]), 6)
        self.assertEqual(len([r for r in routes if r.endswith("/medellin")]), 6)

    def test_location_fields(self):
        self.assertEqual(scraper._location_fields(("tolima", "Tolima")), ("tolima", "Tolima", "Tolima"))
        self.assertEqual(
            scraper._location_fields(("zona-norte/bogota", "Bogotá D.C. (zona norte)", "Bogotá D.C.")),
            ("zona-norte/bogota", "Bogotá D.C. (zona norte)", "Bogotá D.C."),
        )

    def test_window_alert_thresholds(self):
        self.assertIsNone(scraper.search_window_alert("X", None))
        self.assertIsNone(scraper.search_window_alert("X", 9_000))
        self.assertIn("cerca del tope", scraper.search_window_alert("X", 9_588))
        self.assertIn("se perderan", scraper.search_window_alert("X", 10_001))

    def test_new_checkpoint_has_every_search(self):
        cp = scraper.new_checkpoint()
        self.assertEqual(list(cp["departments"]), [e[0] for e in scraper.LOCATIONS])
        self.assertTrue(all(not d["done"] and d["last_page"] is None for d in cp["departments"].values()))


class RunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.sent = []
        self.requested = []
        self.locations = [
            ("alpha", "Alfa"),                                    # 3 paginas
            ("beta", "Beta"),                                     # la primera pagina nunca responde
            ("gamma/ciudad", "Gamma (ciudad)", "Departamento G"),  # 12.000 anuncios: pasa del tope
            ("delta", "Delta"),                                   # el total crece mientras se recorre
        ]
        patches = [
            mock.patch.object(scraper, "LOCATIONS", self.locations),
            mock.patch.object(scraper, "CHECKPOINT_PATH", self.tmp / ".checkpoint.json"),
            mock.patch.object(scraper, "fetch_page", self.fake_fetch),
            mock.patch.object(scraper.time, "sleep", lambda s: None),
            mock.patch.object(scraper, "send_telegram_message", self.sent.append),
            mock.patch.object(scraper, "MAX_RUNTIME_SECONDS", None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def fake_fetch(self, url):
        tail = url.split("/venta/apartamentos/")[1]
        route, _, page = tail.rpartition("/pagina")
        page = int(page)
        self.requested.append((route, page))
        if route == "alpha":
            return page_html([item(1000 + page)], 3, 3)
        if route == "beta":
            return None
        if route == "gamma/ciudad":
            return page_html([item(2000 + page)], 572, 12_000)
        if route == "delta":
            # La primera pagina dice 2 paginas; al llegar a la 2 el sitio ya dice 4 (entraron anuncios).
            return page_html([item(3000 + page)], 2 if page == 1 else 4, 80)
        raise AssertionError(f"ruta inesperada {route}")

    def run_scrape(self):
        out = scraper.scrape_national(output_dir=self.tmp)
        with out.open(encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
        cp = json.loads((self.tmp / ".checkpoint.json").read_text(encoding="utf-8"))
        return rows, cp

    def test_full_run(self):
        rows, cp = self.run_scrape()
        self.assertTrue(cp["done"])
        d = cp["departments"]

        # alpha: 3 paginas, 1 anuncio por pagina
        self.assertEqual(d["alpha"]["last_page"], 3)
        self.assertEqual([r for r in self.requested if r[0] == "alpha"], [("alpha", 1), ("alpha", 2), ("alpha", 3)])

        # beta: no hay bucle infinito; se intento una vez y queda marcada con error
        self.assertEqual([r for r in self.requested if r[0] == "beta"], [("beta", 1)])
        self.assertTrue(d["beta"]["done"])
        self.assertEqual(d["beta"]["error"], "primera pagina no disponible")
        self.assertTrue(any("Beta" in m and "no respondio" in m for m in self.sent))

        # gamma: no se piden paginas mas alla del tope y se avisa
        gamma_pages = [p for r, p in self.requested if r == "gamma/ciudad"]
        self.assertEqual(max(gamma_pages), scraper.MAX_PAGES_PER_SEARCH)
        self.assertEqual(len(gamma_pages), scraper.MAX_PAGES_PER_SEARCH)
        self.assertEqual(d["gamma/ciudad"]["total"], 12_000)
        self.assertTrue(any("se perderan" in m and "Gamma (ciudad)" in m for m in self.sent))

        # delta: el numero de paginas se actualiza sobre la marcha (2 -> 4)
        self.assertEqual([p for r, p in self.requested if r == "delta"], [1, 2, 3, 4])
        self.assertEqual(d["delta"]["last_page"], 4)

        # Las columnas de zona: la ruta va en department_slug y el departamento en department
        gamma_row = next(r for r in rows if r["listing_id"] == "2001")
        self.assertEqual(gamma_row["department_slug"], "gamma/ciudad")
        self.assertEqual(gamma_row["department"], "Departamento G")
        alpha_row = next(r for r in rows if r["listing_id"] == "1001")
        self.assertEqual(alpha_row["department"], "Alfa")

        # El mensaje final cuenta la busqueda con error aparte
        summary = scraper.build_summary_message(cp, self.tmp / "x.csv", len(rows))
        self.assertIn("3/4 busquedas cubiertas", summary)
        self.assertIn("Sin datos por error: Beta", summary)

    def test_resume_does_not_repeat_finished_searches(self):
        self.run_scrape()
        cp_path = self.tmp / ".checkpoint.json"
        cp = json.loads(cp_path.read_text(encoding="utf-8"))
        cp["done"] = False
        cp["finished_at"] = None
        cp["departments"]["delta"].update(done=False, next_page=3)
        cp_path.write_text(json.dumps(cp), encoding="utf-8")
        self.requested.clear()
        self.run_scrape()
        self.assertEqual(self.requested, [("delta", 3), ("delta", 4)])

    def test_checkpoint_from_older_list_gets_new_searches(self):
        cp = scraper.new_checkpoint()
        del cp["departments"]["delta"]
        scraper.save_checkpoint(cp)
        _rows, cp2 = self.run_scrape()
        self.assertIn("delta", cp2["departments"])
        self.assertTrue(cp2["done"])


if __name__ == "__main__":
    unittest.main()
