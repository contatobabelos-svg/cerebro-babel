#!/bin/sh
# Garante o servidor de pé e abre o Cérebro Babel no Chrome em modo app.
systemctl --user start cerebro-babel.service 2>/dev/null
i=0
while [ $i -lt 20 ] && ! curl -sf http://127.0.0.1:3077/api/info >/dev/null; do sleep 0.25; i=$((i+1)); done
for b in google-chrome google-chrome-stable chromium chromium-browser; do
  command -v "$b" >/dev/null && exec "$b" --app=http://127.0.0.1:3077 --class=CerebroBabel --window-size=1440,900
done
exec xdg-open http://127.0.0.1:3077
