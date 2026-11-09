/* Lets Astar work offline once it's installed on a phone (Add to Home Screen). Only runs when served from a web address, not when opened as a file on the Mac. */
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Offline support unavailable", e)));
}
