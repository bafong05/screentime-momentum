# Screen Time Momentum

Chrome extension for turning browsing activity into sessions, goals, and analytics insights.

## Testing the Extension

If the Chrome Web Store review is still pending, you can test the extension locally as an unpacked extension.

### 1. Download the project

Either:

- clone the repo with Git
- or download the repo as a ZIP from GitHub and unzip it

### 2. Load it into Chrome

1. Open `chrome://extensions`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select this project folder:

```text
/Users/baileyfong/School/2025-2026/CS 195/cs195-capstone-project
```

After that, the extension should appear in Chrome and can be pinned from the extensions menu.

### 3. If you want to test the AI assistant

The AI assistant uses a local FastAPI backend during development.

Run:

```bash
cd "/Users/baileyfong/School/2025-2026/CS 195/cs195-capstone-project"
export OPENAI_API_KEY="your-key-here"
./run_ai_backend.sh
```

The extension will call:

```text
http://127.0.0.1:8000/analytics/ai
```

If you do not start the backend, the extension UI can still be tested, but AI assistant features will not work correctly.

## What to Test

Helpful areas to try:

- starting a session with an intended duration
- letting a session run over and choosing whether to extend or end it
- checking whether the dashboard updates correctly
- looking at Today, History, and Analytics views
- asking the AI assistant questions about browsing habits
- noticing anything confusing, slow, or inaccurate

## How to Share Feedback

Please leave feedback through GitHub Issues.

Good things to include:

- what you were trying to do
- what happened
- what you expected to happen
- screenshots or screen recordings if helpful
- whether the issue was in:
  - Popup
  - Dashboard
  - Analytics
  - AI assistant
  - Session tracking

If you are giving general usability feedback, it is also helpful to mention:

- what felt intuitive
- what felt confusing
- what felt slow
- what you would want changed first

## Known Development Notes

- This project is still being refined, so some session-tracking edge cases may still exist.
- If Chrome shows an extension error after loading, try reloading the unpacked extension once in `chrome://extensions`.
- If the AI assistant is enabled, make sure the local backend is running before testing AI features.

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
