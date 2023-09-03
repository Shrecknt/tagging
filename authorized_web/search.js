const ws = new WebSocket(`wss://${window.location.host}/api`);
ws.addEventListener("open", (event) => {
    console.log("open event", event);
    currentQuery = "";
    requestNextPage();
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

    // console.log(data.type, data.query, currentQuery);
    switch (data.type) {
        case "searchResults":
            if (data.query === currentQuery) {
                // if (data.value.length < 1) allResultsLoaded = true;
                loadSearchResults(data.value);
                if (checkScroll() && !allResultsLoaded) requestNextPage();
            }
            break;
        default:
            throw new Error(`Unknown packet ${data.type}`);
    }
});

let allResultsLoaded = false;
let page = 0;
let currentQuery = "";

function loadSearchResults(value) {
    console.log("Displaying output");
    // document.getElementById("display").innerText = JSON.stringify(value, null, 4);
    value.forEach(displayResult);
}

function displayResult(value) {
    const url = `/file/${value.userid}/${value.fileid}`;
    const container = document.createElement("A");
    const suffix = (value.mimetype === "image/gif") ? ".gif" : ""; // discor y u make me do this
    container.setAttribute("href", url + suffix);
    container.classList.add("container");
    const thumbnail = document.createElement("DIV");
    thumbnail.classList.add("thumbnail");
    if ((value.mimetype ?? "").startsWith("image/")) {
        thumbnail.style.backgroundImage = `url(${url}${suffix})`;
    } else {
        thumbnail.style.backgroundImage = "url(/unknown.png)";
    }
    container.appendChild(thumbnail);
    const caption = document.createElement("DIV");
    caption.classList.add("caption");
    caption.innerText = value.title ?? value.filename;
    container.appendChild(caption);
    document.getElementById("display").appendChild(container);
}

function checkScroll() {
    const rect = document.getElementById("scrollDetector").getBoundingClientRect();
    const viewHeight = Math.max(document.documentElement.clientHeight, window.innerHeight);
    return !(rect.bottom < 0 || rect.top - viewHeight >= 0);
}

window.addEventListener("scroll", () => {
    const inView = checkScroll();
    if (inView && !allResultsLoaded) requestNextPage();
});

function requestNextPage() {
    console.log("requesting", page);
    ws.send(JSON.stringify({ "type": "search", "value": currentQuery, "page": page++ }));
}

const searchBar = document.getElementById("search");
searchBar.addEventListener("keypress", ({ key }) => {
    if (key === "Enter") {
        document.getElementById("display").innerHTML = "";
        allResultsLoaded = false;
        currentQuery = searchBar.value;
        page = 0;
        requestNextPage();
    }
});
