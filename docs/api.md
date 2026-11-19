# REST API

Everything the web UI does goes through the REST API under `/api`, so
everything can be scripted.

- **Reference**: open `http://<burrow>:8080/api/docs/` (Swagger UI) or fetch
  the OpenAPI 3 document at `/api/openapi.json`. Both are public: they
  describe the API, they contain no data. The document is generated from the
  same zod schemas the server validates with (`packages/shared`), so it
  cannot drift from the code.
- **Errors** always look like
  `{ "error": { "code": "DNS_CONFLICT", "message": "…", "details": … } }`.

## Authentication

Create a token in **Settings › API tokens**. It is shown once; Burrow only
stores a keyed hash of it (HMAC-SHA256 with the instance key). Send it as a
bearer token:

```bash
export BURROW=http://192.168.1.10:8080
export TOKEN=burrow_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

curl -s -H "Authorization: Bearer $TOKEN" $BURROW/api/hosts
```

Requests with a token do not need the CSRF header (browsers never attach an
`Authorization` header on their own). A token acts as its owner but cannot
create or revoke tokens, nor change the password. Other `Authorization`
headers, such as the Basic auth of a reverse proxy in front of Burrow, are
ignored, so they do not break the browser session.

The web UI uses a session cookie instead; mutating requests then need the
`X-CSRF-Token` header returned by `GET /api/auth/me`.

## Examples

Publish a service:

```bash
ZONE=$(curl -s -H "Authorization: Bearer $TOKEN" $BURROW/api/zones \
  | jq -r '.zones[] | select(.name=="example.com") | .id')

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"subdomain\":\"grafana\",\"zoneId\":\"$ZONE\",\"service\":\"http://grafana:3000\"}" \
  $BURROW/api/hosts
```

Back up the configuration every night (no secrets in the file):

```bash
curl -s -H "Authorization: Bearer $TOKEN" $BURROW/api/config/export > burrow-config.json
```

Restore it on a new server, checking first with a dry run:

```bash
jq '{config: ., mode: "merge", dryRun: true}' burrow-config.json \
  | curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d @- $BURROW/api/config/import
```

Check for changes made in the Cloudflare dashboard, then revert them:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" $BURROW/api/drift/check | jq '.items'
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"strategy":"revert"}' $BURROW/api/drift/resolve
```

Back up the database now and download the file:

```bash
NAME=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" $BURROW/api/backups | jq -r .name)
curl -s -H "Authorization: Bearer $TOKEN" -o "$NAME" $BURROW/api/backups/$NAME
```

Expose a service for two hours, starting from a template:

```bash
UNTIL=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"subdomain\":\"demo\",\"zoneId\":\"$ZONE\",\"service\":\"http://jellyfin:8096\",\"template\":\"jellyfin\",\"expiresAt\":\"$UNTIL\"}" \
  $BURROW/api/hosts
```

Put a host in maintenance until tomorrow morning, then bring it back:

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"enabled":true,"until":"2026-11-20T08:00:00Z"}' $BURROW/api/hosts/12/maintenance
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"enabled":false}' $BURROW/api/hosts/12/maintenance
```

Rescan Docker labels now:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" $BURROW/api/docker/scan | jq '.containers'
```

Uptime of every host, and the traffic of one host over 7 days:

```bash
curl -s -H "Authorization: Bearer $TOKEN" $BURROW/api/monitoring \
  | jq '.hosts[] | {hostname, state, uptime}'
curl -s -H "Authorization: Bearer $TOKEN" "$BURROW/api/traffic/hosts/12?range=7d" | jq '.totals'
```

Send alerts to an ntfy topic, then test the channel:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Phone","type":"ntfy","events":["host.down","host.up","tunnel.down"],"config":{"topic":"my-burrow-alerts"}}' \
  $BURROW/api/notifications/channels
curl -s -X POST -H "Authorization: Bearer $TOKEN" $BURROW/api/notifications/channels/1/test
```

## Configuration file

`GET /api/config/export` returns:

```json
{
  "burrow": 1,
  "exportedAt": "2026-11-19T10:00:00.000Z",
  "version": "0.3.0",
  "zones": ["example.com"],
  "tunnels": [
    {
      "name": "burrow-3fa9c1",
      "cfId": "…",
      "origin": "created",
      "runConnector": true,
      "isDefault": true
    }
  ],
  "hosts": [
    {
      "subdomain": "jellyfin",
      "zone": "example.com",
      "tunnel": "burrow-3fa9c1",
      "service": "http://jellyfin:8096",
      "path": "",
      "enabled": true,
      "options": {
        "noTLSVerify": false,
        "httpHostHeader": "",
        "originServerName": "",
        "extra": {}
      },
      "access": { "enabled": false, "emails": [], "emailDomains": [], "sessionDuration": "24h" },
      "home": { "visible": true, "title": "", "description": "", "icon": "", "group": "Media" }
    }
  ]
}
```

Import rules (`POST /api/config/import` with `{ config, mode, dryRun }`):

- Zones are matched **by name** among the zones the token can see, and
  enabled. A host whose zone is missing is skipped with a warning.
- Tunnels are matched by Cloudflare id, then by name. A tunnel that exists in
  the account but not in Burrow is imported; a missing one is created. Hosts
  of a tunnel that cannot be set up go to the default tunnel.
- Hosts are matched by **hostname + path**: created when new, updated when
  different. `mode: "replace"` also deletes hosts that are not in the file.
- A full sync runs at the end; its result is in the report.
