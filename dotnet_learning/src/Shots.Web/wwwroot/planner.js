window.peptidePlanner = {
  setTheme(theme) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("peptide-planner-theme", theme);
  },
  getTheme() {
    return localStorage.getItem("peptide-planner-theme") || "dark";
  },
  downloadFile(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  },
  printPage(schedule) {
    document.body.classList.toggle("printing-schedule", Boolean(schedule));
    window.print();
  },
  clearPrintMode() {
    document.body.classList.remove("printing-schedule");
  }
};

window.addEventListener("afterprint", () => window.peptidePlanner.clearPrintMode());
