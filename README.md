# AutoFix API Backend

Express backend for AutoFix CRM with all suppliers:
- Impex Japan
- APEC Dubai  
- Emex Dubai
- Stimo (OEM Japan Parts)
- Thunder (PitMax)

## Deploy to Railway

1. Go to [railway.app](https://railway.app) and sign up/login with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Connect this repository
4. Add environment variables in Railway dashboard:

```
APEC_USERNAME=your_apec_username
APEC_PASSWORD=your_apec_password
EMEX_USER=QCJD
EMEX_PASS=Banskolesi123!
STIMO_EMAIL=autofixparts24@gmail.com
STIMO_PASS=11112222
THUNDER_USER=autofix.parts
THUNDER_PASS=414001
```

5. Railway will auto-deploy and give you a URL like `https://autofix-api-production.up.railway.app`

## Update Frontend

In your CRM's App.jsx, change the API URL from:
```javascript
fetch(`/api/supplier-search?q=${...}`)
```

To:
```javascript
fetch(`https://YOUR-RAILWAY-URL.up.railway.app/api/supplier-search?q=${...}`)
```

## API Endpoints

- `GET /api/supplier-search?q=PARTNUMBER` - Search all suppliers
- `GET /api/health` - Health check with cache status

## Local Development

```bash
npm install
npm run dev
```

Server runs on http://localhost:3001
