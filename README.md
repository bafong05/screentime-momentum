# Screen Time Momentum

Chrome extension for turning browsing activity into sessions, goals, and analytics insights.

## AI Assistant Backend

The AI assistant is powered by a FastAPI backend in [ai_backend.py](/Users/baileyfong/School/2025-2026/CS%20195/cs195-capstone-project/ai_backend.py).

### Local development

Run the backend locally:

```bash
cd "/Users/baileyfong/School/2025-2026/CS 195/cs195-capstone-project"
export OPENAI_API_KEY="your-key-here"
./run_ai_backend.sh
```

The extension will call:

```text
http://127.0.0.1:8000/analytics/ai
```

## Deploying to Render

This repo includes [render.yaml](/Users/baileyfong/School/2025-2026/CS%20195/cs195-capstone-project/render.yaml) for a FastAPI web service.

### Option 1: Blueprint deploy

1. Push this repo to GitHub.
2. In Render, create a new Blueprint and connect the repo.
3. Render will detect [render.yaml](/Users/baileyfong/School/2025-2026/CS%20195/cs195-capstone-project/render.yaml).
4. Add the `OPENAI_API_KEY` environment variable in the Render dashboard.
5. Deploy.

### Option 2: Manual web service

If you prefer setting it up by hand in Render:

- Runtime: `Python`
- Build command:

```bash
pip install -r requirements-ai.txt
```

- Start command:

```bash
uvicorn ai_backend:app --host 0.0.0.0 --port $PORT
```

- Health check path:

```text
/health
```

### After Render deploys

Your backend URL will look like:

```text
https://your-render-service.onrender.com/analytics/ai
```

Before publishing the extension, update this constant in [background.js](/Users/baileyfong/School/2025-2026/CS%20195/cs195-capstone-project/background.js):

```js
const DEPLOYED_AI_ASSISTANT_BACKEND_URL = "";
```

Set it to your real Render endpoint, for example:

```js
const DEPLOYED_AI_ASSISTANT_BACKEND_URL = "https://screen-time-momentum-ai.onrender.com/analytics/ai";
```

When that is set, the extension will use the hosted Render backend instead of the local one.

## Chrome extension note

The manifest already allows:

- local AI backend: `http://127.0.0.1:8000/*`
- hosted Render backend: `https://*.onrender.com/*`

If you later move off Render to your own domain, update [manifest.json](/Users/baileyfong/School/2025-2026/CS%20195/cs195-capstone-project/manifest.json) accordingly.
