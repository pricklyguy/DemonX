#!/usr/bin/env bash
# Update DemonX and restart it under PM2. Where DemonX Design is also set up under PM2 (a "demonx-design" process), it is updated
# and restarted too. Nothing is touched while either is busy.
#   bash scripts/update.sh            the latest code on the current branch
#   bash scripts/update.sh v2.0.0     that release (a git tag), the same thing Settings > Updates > Update now installs
#
# 1. Both are asked first whether they are busy (a job, a probe, a laser job or move). If either is, nothing is changed.
# 2. DemonX is updated exactly as before; whatever happens to Design does not affect it.
# 3. Design only if it is already set up here; a failed Design install or build only prints a warning and leaves it running as it was.
# The whole script is read before anything runs, because the git pull below can replace this very file.
set -euo pipefail

# busy_of <http|https> <port>: prints nothing when the program is idle or not running, "BUSY: why" when it is busy, and
# "UNKNOWN: why" when it cannot say (too old to have GET /api/busy, not answering). Local requests only.
busy_of() {
  node -e '
    const [scheme, port] = process.argv.slice(1);
    const say = (s) => { console.log(s); process.exit(0); };
    const req = require(scheme).request({ host: "127.0.0.1", port, path: "/api/busy", timeout: 4000, rejectUnauthorized: false }, (res) => {
      let b = "";
      res.on("data", (c) => { b += c; if (b.length > 10000) req.destroy(); });
      res.on("end", () => {
        if (res.statusCode === 404) say("UNKNOWN: it is too old to say (restart it once so it has the newer code)");
        if (res.statusCode !== 200) say("UNKNOWN: it answered " + res.statusCode);
        try { const j = JSON.parse(b); if (typeof j.busy !== "boolean") throw 0; if (j.busy) say("BUSY: " + String(j.reason || "a job or move is going on").slice(0, 200)); } catch (e) { if (e !== 0 && !(e instanceof SyntaxError)) throw e; say("UNKNOWN: its answer could not be read"); }
      });
    });
    req.on("timeout", () => { req.destroy(); say("UNKNOWN: it did not answer in time"); });
    req.on("error", (e) => { if (e.code === "ECONNREFUSED") process.exit(0); say("UNKNOWN: " + (e.code || e.message)); });
    req.end();
  ' "$1" "$2"
}

# refuse_if_busy <name> <http|https> <port>
refuse_if_busy() {
  local out
  out=$(busy_of "$2" "$3" 2>/dev/null) || out="UNKNOWN: it could not be asked"
  case "$out" in
    "") return 0 ;;
    BUSY:*)
      echo "Not updating: $1 is busy (${out#BUSY: }). Nothing was changed. Try again when it is idle." >&2
      exit 1 ;;
    *)
      echo "$1 cannot say whether it is busy: ${out#UNKNOWN: }." >&2
      if [ -t 0 ]; then
        local answer
        read -r -p "Update anyway? Only say yes if you know nothing is running. [y/N] " answer
        [[ "$answer" =~ ^[Yy]$ ]] || { echo "Not updating. Nothing was changed." >&2; exit 1; }
      else
        echo "Not updating (there is nobody here to ask). Nothing was changed." >&2
        exit 1
      fi ;;
  esac
}

# value of KEY in design/design.env (what Design's PM2 definition reads), or nothing
design_env() {
  grep -E "^[[:space:]]*$1=" design/design.env 2>/dev/null | tail -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/^"(.*)"$/\1/' || true
}

main() {
  cd "$(dirname "$0")/.."

  # Is DemonX Design set up here? (only then is it asked, updated and restarted)
  local design=0 dport dscheme=http
  if [ -f design/package.json ] && pm2 describe demonx-design >/dev/null 2>&1; then design=1; fi

  # 1. nothing is changed while either one is busy
  refuse_if_busy "DemonX" http "${DEMONX_PORT:-${PORT:-8080}}"
  if [ "$design" = 1 ]; then
    dport=$(design_env DESIGN_PORT); dport=${dport:-8090}
    [ -n "$(design_env DESIGN_TLS_CERT)" ] && dscheme=https
    refuse_if_busy "DemonX Design" "$dscheme" "$dport"
  fi

  # 2. DemonX
  # package-lock.json is rewritten by every npm install (differently on a Pi); a changed copy would stop git from pulling or switching branches
  git checkout -- package-lock.json 2>/dev/null || true
  if [ $# -ge 1 ]; then
    [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "Give a release tag like v2.0.0 (see the Releases page), or nothing to update the current branch." >&2; exit 1; }
    git fetch --no-tags origin "+refs/tags/$1:refs/tags/$1"
    git checkout --detach "refs/tags/$1"
  elif git symbolic-ref -q HEAD >/dev/null; then
    git pull
  else
    echo "This folder is on a release (Update now put it there), not on a branch, so there is nothing to pull." >&2
    echo "Give the release to install:  bash scripts/update.sh v2.0.0   (or: git checkout main  to follow the branch again)" >&2
    exit 1
  fi
  npm install
  # the new screen is built aside (web/dist-next) so the running server keeps serving the old one meanwhile; DemonX swaps it in when it restarts
  npm run build:staging
  # mark the staged screen with the version it was built for: DemonX only swaps in a screen that matches the version it starts as
  node -e "require('fs').writeFileSync('web/dist-next/.staged.json', JSON.stringify({ version: require('./package.json').version }))"
  if pm2 describe demonx >/dev/null 2>&1; then
    pm2 restart demonx
  else
    pm2 start ecosystem.config.cjs
    pm2 save
  fi
  pm2 status demonx

  # 3. DemonX Design: a problem here is only a warning (DemonX is already updated and running)
  if [ "$design" = 1 ]; then
    echo "Updating DemonX Design..."
    if (cd design && npm ci --no-audit --no-fund && rm -rf dist-next && npm run build -- --outDir dist-next); then
      # the screen it serves is replaced only now, by renaming, and put back if Design cannot be restarted
      rm -rf design/dist-prev
      [ -d design/dist ] && mv design/dist design/dist-prev
      mv design/dist-next design/dist
      if pm2 restart demonx-design; then
        pm2 status demonx-design
      else
        rm -rf design/dist-next
        mv design/dist design/dist-next
        [ -d design/dist-prev ] && mv design/dist-prev design/dist
        echo "WARNING: DemonX Design could not be restarted; it keeps running as it was. Try: pm2 restart demonx-design" >&2
      fi
    else
      rm -rf design/dist-next
      echo "WARNING: DemonX Design was not updated (its install or build failed, see above); it keeps running as it was. DemonX itself is updated." >&2
    fi
  fi
}

main "$@"
exit
