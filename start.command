#!/bin/bash
# Локальный запуск квиза.
# Есть Node.js → node server.js: локальный режим (телефоны и второй ноутбук по Wi-Fi, интернет не нужен).
# Нет Node.js → простой python-сервер: телефоны работают через интернет (MQTT).
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  node server.js &
else
  echo "Node.js не найден — запускаю простой сервер (телефоны пойдут через интернет)."
  echo "Для локального режима без интернета поставь Node.js: https://nodejs.org"
  python3 -m http.server 8777 &
fi
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM
sleep 1
open "http://localhost:8777/index.html"
wait $SERVER_PID
