let reader = null;
const decoder = new TextDecoder();
let buffer = "";
let workerUid = null;

function send(obj) {
    self.postMessage({
        type: "result",
        result: obj,
        uid: workerUid,
    });
}
function processJSON(objects) {
    return new Promise((resolve) => {
        while (true) {
            try {
                send(JSON.parse(objects.pop()));
                if (!objects.length) {
                    break;
                }
            } catch (e) {
                console.error(e);
            }
        }
        resolve();
    });
}
async function processText({ done, value }) {
    if (!done) {
        const chunk = decoder.decode(value);
        buffer += chunk;
        const objects = buffer.split("\n");
        buffer = objects.pop();
        if (objects.length) {
            await processJSON(objects);
        }
    } else if (buffer.length) {
        const objects = buffer.split("\n");
        await processJSON(objects);
    }
    return done;
}
async function readStream(stream) {
    reader = stream.getReader();
    let done = false;
    while (!done) {
        const nextChunk = await reader.read();
        done = await processText(nextChunk);
    }
}
async function fetchData(url, args) {
    const requestArgs = Object.assign(
        {
            method: "GET",
            headers: {
                Accept: "application/x-ndjson",
            },
        },
        args
    );
    const response = await fetch(url, requestArgs);
    if (response.ok) {
        if (response.status === 204) {
            self.postMessage({
                type: "done",
                uid: workerUid,
            });
        } else {
            await readStream(response.body);
            self.postMessage({
                type: "done",
                uid: workerUid,
            });
        }
    } else {
        console.error(`${response.status}: ${response.statusText}`);
        self.postMessage({
            type: "error",
            uid: workerUid,
        });
    }
}
self.onmessage = (e) => {
    const { url, uid, args } = e.data;
    workerUid = uid;
    fetchData(url, args);
};

