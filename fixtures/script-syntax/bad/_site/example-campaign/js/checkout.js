document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("[data-next-checkout]");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    form.classList.add("is-submitting");
  });
});
});
