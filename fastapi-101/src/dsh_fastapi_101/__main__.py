"""Run the tutorial server with Uvicorn."""

import uvicorn


if __name__ == "__main__":
    uvicorn.run("dsh_fastapi_101.app:app", host="127.0.0.1", port=8000, reload=False)
