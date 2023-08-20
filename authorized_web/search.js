const ws = new WebSocket(`wss://${window.location.hostname}`);
ws.addEventListener("open", (event) => {
    console.log("open event", event);
    ws.send(JSON.stringify({ "type": "search", "value": "meme" }));
});
ws.addEventListener("close", (event) => {
    console.log("close event", event);
});
ws.addEventListener("error", (event) => {
    console.log("error event", event);
});
ws.addEventListener("message", async (msgBlob) => {
    const msg = msgBlob.data;
    const data = JSON.parse(msg);
    console.log("data", data);

    switch (data.type) {
        case "searchResults":
            if (data.query === currentQuery) {
                loadSearchResults(data.value);
            }
            break;
        default:
            throw new Error(`Unknown packet ${data.type}`);
    }
});

let currentQuery = "";

function loadSearchResults(value) {

}