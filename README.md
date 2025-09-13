# BidSpot — MVP Frontend

A polished single-page demo UI for the BidSpot internal GPU marketplace concept.

**What this repo contains**
- `index.html` — single page UI
- `styles.css` — polished, responsive styling
- `app.js` — simulated auction & job queue logic for demo

**Purpose**
This is a frontend-only MVP to demo the product idea to investors. It simulates auction cadence, clearing prices, and shows team credits & job submission. Hook this UI into your backend services (API endpoints for jobs, auctions, billing, metrics) to make it production-ready.

**How to run**
1. Commit files to a GitHub repo.
2. Serve locally (any static server). Quick:
   ```bash
   # with Python 3
   python -m http.server 8000
   # then open http://localhost:8000

