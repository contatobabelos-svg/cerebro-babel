#!/bin/sh
# Garante o servidor de pé e abre o Cérebro Babel no Chrome em modo app.

# Detectar SO
if [ "$(uname)" = "Darwin" ]; then
  OPEN_CMD="open"
  # Mac: tentar Chrome, senão Safari
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [ -x "$CHROME" ]; then
    BROWSER="$CHROME"
  else
    BROWSER="open -a Safari"
  fi
else
  OPEN_CMD="xdg-open"
  # Linux: procurar Chrome/Chromium
  for b in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$b" >/dev/null; then
      BROWSER="$b"
      break
    fi
  done
  BROWSER="${BROWSER:-xdg-open}"
fi

# Iniciar servidor (systemd no Linux, direto no Mac)
if [ "$(uname)" != "Darwin" ]; then
  systemctl --user start cerebro-babel.service 2>/dev/null
fi

# Aguardar servidor
i=0
while [ $i -lt 20 ] && ! curl -sf http://127.0.0.1:3077/api/info >/dev/null; do
  sleep 0.25
  i=$((i+1))
done

# Abrir navegador
if [ "$BROWSER" = "xdg-open" ] || [ "$BROWSER" = "open -a Safari" ]; then
  exec $BROWSER http://127.0.0.1:3077
else
  exec "$BROWSER" --app=http://127.0.0.1:3077 --class=CerebroBabel --window-size=1440,900
fi
