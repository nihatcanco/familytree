# Family-tree app image. Linux container (Docker Desktop / WSL2 on the
# Windows Jenkins box). PostgreSQL runs as its own container, see
# docker-compose.yml.
#
#   base  - runtime deps + the app files server.py serves
#   test  - base + tests/, runs the API integration test (Jenkins 'Test' stage)
#   app   - what gets deployed (default target)

FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Only what server.py needs at runtime; it resolves everything relative to its
# own directory and serves just index.html/version.json/robots.txt/css/js.
COPY server.py schema.sql index.html robots.txt version.json ./
COPY css ./css
COPY js ./js

FROM base AS test
COPY tests ./tests
CMD ["python", "tests/test_api.py"]

FROM base AS app
RUN useradd --system --no-create-home familytree
USER familytree
# Inside the container the app must listen on all interfaces so Docker can
# forward the published host port (docker-compose.yml) to it.
ENV FAMILYTREE_HOST=0.0.0.0
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/', timeout=4)"]
CMD ["python", "server.py", "8000"]
