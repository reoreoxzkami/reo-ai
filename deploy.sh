#!/bin/bash
# Deploy via Cloudflare API (needs a Cloudflare API token on api.cloudflare.com). Most people should use `npx wrangler deploy` instead.
set -e; cd "$(dirname "$0")"
python3 build.py
source ./.deploy.env  # ACC (Cloudflare account id), KV_ID, NAME — not committed
MIG=${MIG:-null}  # first deploy: MIG='{"new_tag":"v1","new_sqlite_classes":["Brain"]}'
META="{\"main_module\":\"worker.js\",\"compatibility_date\":\"2025-09-01\",\"bindings\":[{\"type\":\"ai\",\"name\":\"AI\"},{\"type\":\"kv_namespace\",\"name\":\"KV\",\"namespace_id\":\"$KV_ID\"},{\"type\":\"durable_object_namespace\",\"name\":\"BRAIN\",\"class_name\":\"Brain\"}],\"migrations\":$MIG,\"keep_bindings\":[\"secret_text\"]}"
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/$NAME" -F "metadata=$META;type=application/json" \
  -F "worker.js=@src/worker.js;filename=worker.js;type=application/javascript+module" -F "assets.js=@src/assets.js;filename=assets.js;type=application/javascript+module" | python3 -c "import sys,json;d=json.load(sys.stdin);print('upload',d['success'],d.get('errors'))"
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/$NAME/subdomain" -H 'content-type: application/json' -d '{"enabled":true,"previews_enabled":false}' | python3 -c "import sys,json;d=json.load(sys.stdin);print('subdomain',d['success'])"
if [ "$SETUP" = 1 ]; then
  python3 -c "import json;print(json.dumps({'name':'APP_PASSCODE','text':open('.passcode').read().strip(),'type':'secret_text'}))" > /tmp/sec.json
  curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/$NAME/secrets" -H 'content-type: application/json' --data @/tmp/sec.json | python3 -c "import sys,json;d=json.load(sys.stdin);print('secret',d['success'],d.get('errors'))"; rm -f /tmp/sec.json
fi
