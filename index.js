const version = "0.0.3"

let allowedDomains = process?.env?.ALLOWED_REMOTE_DOMAINS?.split(",") || ["*"];
let imgproxyUrl = process?.env?.IMGPROXY_URL || "http://imgproxy:8080";
if (process.env.NODE_ENV === "development") {
    imgproxyUrl = "http://localhost:8888"
}
allowedDomains = allowedDomains.map(d => d.trim());
let cacheInvalidationTime = process?.env?.CACHE_INVALIDATION_TIME || 24 * 60 * 60;

Bun.serve({
    port: 3000,
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/") {
            return new Response(`<h3>Next Image Transformation v${version}</h3>More info <a href="https://github.com/coollabsio/next-image-transformation">https://github.com/coollabsio/next-image-transformation</a>.`, {
                headers: {
                    "Content-Type": "text/html",
                },
            });
        }

        if (url.pathname === "/health") {
            return new Response("OK");
        };
        if (url.pathname.startsWith("/image/")) {
            const cached = await getCached(url);
            if (cached) return cached;
            return await resize(url);
        }
        return Response.redirect("https://github.com/coollabsio/next-image-transformation", 302);
    }
});

async function resize(url) {
    const preset = "pr:sharp/f:webp"
    const src = url.pathname.split("/").slice(2).join("/");
    const origin = new URL(src).hostname;
    const allowed = allowedDomains.filter(domain => {
        if (domain === "*") return true;
        if (domain === origin) return true;
        if (domain.startsWith("*.") && origin.endsWith(domain.split("*.").pop())) return true;
        return false;
    })
    if (allowed.length === 0) {
        return new Response(`Domain (${origin}) not allowed. More details here: https://github.com/coollabsio/next-image-transformation`, { status: 403 });
    }
    const width = url.searchParams.get("width") || 0;
    const height = url.searchParams.get("height") || 0;
    const quality = url.searchParams.get("quality") || 75;
    try {
        const urlString = `${imgproxyUrl}/${preset}/resize:fill:${width}:${height}/q:${quality}/plain/${src}`
        const image = await fetch(urlString, {
            headers: {
                "Accept": "image/avif,image/webp,image/apng,*/*",
            }
        })
        if (!image.ok) throw new Error();
        const headers = new Headers(image.headers);
        headers.set("Server", "NextImageTransformation");
        const imageArrayBuffer = await image.arrayBuffer();
        await writeImageToCache(url, imageArrayBuffer, headers);
        return getCached(url);
    } catch (e) {
        console.log(e)
        return new Response("Error resizing image")
    }
}

async function writeImageToCache(url, image, headers) {
    const cacheKey = encodeURIComponent(url.pathname + url.search + version);
    const path = "./cache/" + cacheKey;
    const metaPath = path + ".meta";
    const meta = JSON.stringify({
        headers: headers,
        cachedAt: Date.now(),
    })
    await Bun.write(path, image);
    await Bun.write(metaPath, meta);
}

async function getCached(url) {
    const cacheKey = encodeURIComponent(url.pathname + url.search + version);
    const file = Bun.file("./cache/" + cacheKey);
    const metaFile = Bun.file("./cache/" + cacheKey + ".meta");
    const exists = await file.exists() && await metaFile.exists();
    if (!exists) return null;
    const metaData = JSON.parse(await metaFile.text());
    if (Date.now() - metaData.cachedAt > cacheInvalidationTime * 1000) return null;
    const headers = new Headers(metaData.headers);
    return new Response(file, {headers});
}