# Family-tree app image (a Linux container). PostgreSQL runs as its own
# container, see docker-compose.yml.
#
#   deps       - Python + the runtime requirements
#   base       - deps + the app files server.py serves
#   test-deps  - deps + Playwright and Chromium for the browser test, kept off
#                base so app changes don't download the browser again
#   test       - test-deps + the app files + tests/, runs both test suites
#                (Jenkins 'Test' stage)
#   app        - what gets deployed (default target)

FROM python:3.12-slim AS deps
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM deps AS base
# Only what server.py needs at runtime; it resolves everything relative to its
# own directory and serves just index.html/version.json/robots.txt/css/js.
COPY server.py schema.sql index.html robots.txt version.json ./
COPY css ./css
COPY js ./js

FROM deps AS test-deps
COPY requirements-dev.txt .
RUN pip install --no-cache-dir -r requirements-dev.txt \
 && python -m playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

FROM test-deps AS test
COPY --from=base /app ./
COPY tests ./tests
# Both suites reset the same database, so they run one after the other.
CMD ["sh", "-c", "python tests/test_api.py && python tests/test_ui.py"]

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
