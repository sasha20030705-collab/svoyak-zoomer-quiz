#!/bin/bash
# Локальный запуск квиза: поднимает сервер на 8777 и открывает пульт ведущего.
cd "$(dirname "$0")"
python3 -m http.server 8777 &
sleep 1
open http://localhost:8777/index.html
wait
