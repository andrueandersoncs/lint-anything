import asyncio

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

app = FastAPI()


async def fake_video_streamer():
    for i in range(10):
        yield b"some fake video bytes"
        await asyncio.sleep(0)  # simulate async work


@app.get("/")
async def main(plan: str = "free", watched_minutes: int = 0, region: str = "us"):
    if plan == "free":
        if watched_minutes >= 120:
            return {"error": "Daily free limit reached, upgrade to continue"}
        if region not in ("us", "ca", "uk"):
            return {"error": "Free plan not available in your region"}
        max_chunks = 3
    elif plan == "basic":
        max_chunks = 6 if watched_minutes < 600 else 4
    elif plan == "premium":
        max_chunks = 10
    else:
        return {"error": "Unknown plan"}

    async def limited_streamer():
        count = 0
        async for chunk in fake_video_streamer():
            if count >= max_chunks:
                break
            count += 1
            yield chunk

    return StreamingResponse(limited_streamer())
