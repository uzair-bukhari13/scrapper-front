# Esclatech Upwork Dashboard

This repository contains the complete application:

- A Next.js dashboard in the repository root.
- An Express, Socket.IO, MongoDB, and Upwork MCP service in `backend/`.

Both applications remain separate processes so Socket.IO can keep a persistent server, but npm starts and stops them together.

## Requirements

- Node.js 22 or newer
- npm
- MongoDB 6 or newer, or a MongoDB Atlas connection
- An Upwork account with access to Upwork MCP

## First-time setup

Install all frontend and backend workspace dependencies from the repository root:

```powershell
npm.cmd install
```

Create the local environment files if they do not already exist:

```powershell
Copy-Item .env.example .env.local
Copy-Item backend/.env.example backend/.env
```

Use the same `DASHBOARD_API_KEY` in `.env.local` and `backend/.env`. Generate a separate 64-character hexadecimal `TOKEN_ENCRYPTION_KEY` for the backend. See [backend/README.md](backend/README.md) for every backend setting.

## Run the complete application

From the repository root:

```powershell
npm.cmd run dev
```

This starts:

- Frontend: http://localhost:3000
- Backend and Socket.IO: http://localhost:5050

Stopping the root command stops both processes. The frontend proxies REST requests through `/api/backend`, while the browser connects to the backend directly for Socket.IO progress events.

## Other commands

```powershell
npm.cmd run build          # Build the Next.js frontend
npm.cmd start              # Start the built frontend and production backend
npm.cmd run lint           # Lint the frontend
npm.cmd run test:backend   # Run backend unit tests
npm.cmd run check:backend  # Syntax-check backend entry points
```

`npm.cmd start` requires `npm.cmd run build` to have completed first.

## Deployment

Keeping both applications in one repository does not require deploying them as one process. The Next.js frontend can be deployed independently while the persistent Express/Socket.IO backend runs on a Node.js host. Set the deployed backend URLs and allowed frontend origin in the corresponding environment configuration.
