const ws = new WebSocket(`wss://${window.location.host}/api`);
ws.addEventListener("open", (event) => {
    console.log("open event", event);
    currentQuery = "";
    ws.send(JSON.stringify({ "type": "search", "value": currentQuery }));
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

    console.log(data.type, data.query, currentQuery);
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
    console.log("Displaying output");
    document.getElementById("display").innerText = JSON.stringify(value, null, 4);
}