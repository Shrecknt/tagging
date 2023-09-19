{
    const video = document.querySelector("video");

    function focus(ev) {
        if (ev && ev.target === video) {
            return;
        }
        video.focus();
    }

    focus();
    window.addEventListener("focus", focus, true);
}
