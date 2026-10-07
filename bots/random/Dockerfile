# Frontier reference bot: uniform-random legal moves.
FROM python:3.12-slim
WORKDIR /bot
COPY bot.py .
# -u: unbuffered stdout. Buffered output reads as a protocol timeout.
ENTRYPOINT ["python", "-u", "bot.py"]
