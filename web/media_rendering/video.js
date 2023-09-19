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
    window.addEventListener("keypress", (ev) => {
        if (ev.key == "F11") {
            if (window.fullScreen) {
                return;
            }

            ev.preventDefault();
            ev.stopPropagation();
            if (!document.fullscreenElement) {
                video.requestFullscreen();
            } else {
                document.exitFullscreen();
            }
        }
    });
}
