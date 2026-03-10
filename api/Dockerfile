FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

COPY app.py .

CMD ["python", "app.py"]
