# Bundles web/ and gas/ files into src/assets.js (imported by the Worker)
import json
files = {'html': 'web/index.html', 'sw': 'web/sw.js', 'icon': 'web/icon.svg', 'manifest': 'web/manifest.json', 'gas': 'gas/Code.gs'}
a = {k: open(f, encoding='utf-8').read() for k, f in files.items()}
open('src/assets.js', 'w', encoding='utf-8').write('export const ASSETS=' + json.dumps(a, ensure_ascii=False) + ';\n')
print('built src/assets.js')
