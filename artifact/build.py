"""Setzt die Artefakt-Seite aus den Dateien der App zusammen.
Aufruf: python3 build.py <web-ordner> <ausgabe.html>
"""
import pathlib
import re
import sys

web = pathlib.Path(sys.argv[1])
here = pathlib.Path(__file__).parent
out = pathlib.Path(sys.argv[2])

css = (web / 'styles.css').read_text()
html = (web / 'index.html').read_text()
js = (here / 'app.js').read_text()

body = html[html.index('<body>') + len('<body>'):html.index('<script')]
body = body.replace('<main>', '<main>\n    <section id="banner" class="banner" role="status" hidden></section>', 1)

overrides = """
/* ── Artefakt: einzige dunkle Optik, Ränder für Notch und Seitenleisten ── */
:root { color-scheme: dark; }
body { background: var(--bg); color: var(--text); }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 30; background: var(--bg); }
.topbar {
  top: env(safe-area-inset-top, 0px);
  padding: 10px max(16px, env(safe-area-inset-right, 0px)) 10px max(16px, env(safe-area-inset-left, 0px));
}
main {
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
  padding-block: 0 24px;
}
.sheet {
  padding-left: max(18px, env(safe-area-inset-left, 0px));
  padding-right: max(18px, env(safe-area-inset-right, 0px));
}
.lot { min-width: 0; max-width: min(100%, calc((100dvh - 150px) * 26 / 45)); }
@media (min-width: 700px) { .lot { max-width: min(520px, calc((100dvh - 170px) * 26 / 45)); } }
.banner {
  margin: 6px 0 12px; padding: 10px 14px; border-radius: 12px; font-size: 14px;
  background: rgba(91, 140, 255, .12); color: #cbd8ff; box-shadow: inset 0 0 0 1px rgba(91, 140, 255, .3);
}
.banner b { color: var(--text); }
"""

page = f"""<title>Parkplatz</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
{css}
{overrides}
</style>
{body.strip()}
<script>
{js}
</script>
"""
page = re.sub(r'\n{3,}', '\n\n', page)
out.write_text(page)
print(out, len(page), 'Bytes')
