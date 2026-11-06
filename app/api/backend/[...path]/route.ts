import type { NextRequest } from "next/server";

const BACKEND_API_URL = process.env.BACKEND_API_URL || "http://localhost:5050";

function isAllowed(method: string, path: string) {
  if (method === "GET") {
    return path === "health"
      || path === "v1/auth/upwork/status"
      || path === "v1/leads"
      || /^v1\/search-runs\/[0-9a-f-]{36}$/i.test(path);
  }
  if (method === "POST") {
    return path === "v1/auth/upwork/start"
      || path === "v1/auth/upwork/disconnect"
      || path === "v1/search-runs";
  }
  return false;
}

async function proxy(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  const path = segments.join("/");

  if (!isAllowed(request.method, path)) {
    return Response.json({ error: "Unsupported dashboard API route" }, { status: 404 });
  }

  const apiKey = process.env.DASHBOARD_API_KEY;
  if (path !== "health" && !apiKey) {
    return Response.json(
      { error: "DASHBOARD_API_KEY is not configured on the Next.js server" },
      { status: 500 },
    );
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`/${path}`, BACKEND_API_URL.replace(/\/$/, ""));
  targetUrl.search = incomingUrl.search;

  try {
    const contentType = request.headers.get("content-type");
    const response = await fetch(targetUrl, {
      method: request.method,
      cache: "no-store",
      headers: {
        ...(contentType ? { "Content-Type": contentType } : {}),
        ...(apiKey && path !== "health" ? { "x-api-key": apiKey } : {}),
      },
      body: request.method === "GET" ? undefined : await request.text(),
    });

    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") || "application/json",
        ...(response.headers.get("retry-after")
          ? { "Retry-After": response.headers.get("retry-after")! }
          : {}),
      },
    });
  } catch {
    return Response.json(
      { error: "The dashboard backend is unavailable" },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
