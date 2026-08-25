(function () {
  let nextId = 0;
  const instances = new Set();

  function uniqueOptions(values) {
    return [...new Set((values || [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" }));
  }

  function attach(input, getOptions, settings = {}) {
    if (!input || typeof getOptions !== "function" || input.dataset.previewReady === "true") return;

    const wrapper = document.createElement("div");
    const menu = document.createElement("div");
    const heading = document.createElement("div");
    const list = document.createElement("div");
    const listId = `filter-preview-list-${++nextId}`;
    let visibleOptions = [];
    let activeIndex = -1;
    let closeTimer;

    wrapper.className = "filter-preview-shell";
    menu.className = "filter-preview-menu";
    heading.className = "filter-preview-heading";
    list.className = "filter-preview-list";
    list.id = listId;
    list.setAttribute("role", "listbox");
    menu.hidden = true;
    menu.append(heading, list);
    input.parentNode.insertBefore(wrapper, input);
    wrapper.append(input, menu);

    input.dataset.previewReady = "true";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-haspopup", "listbox");
    input.setAttribute("aria-controls", listId);
    input.setAttribute("aria-expanded", "false");

    function setActive(index) {
      const items = [...list.querySelectorAll(".filter-preview-option")];
      if (!items.length) {
        activeIndex = -1;
        input.removeAttribute("aria-activedescendant");
        return;
      }
      activeIndex = Math.max(0, Math.min(index, items.length - 1));
      items.forEach((item, itemIndex) => item.classList.toggle("active", itemIndex === activeIndex));
      const active = items[activeIndex];
      input.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    }

    function choose(value) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      close();
      input.focus();
    }

    function renderOptions() {
      const allOptions = uniqueOptions(getOptions());
      const query = input.value.trim().toLocaleLowerCase();
      const matches = query
        ? allOptions.filter((value) => value.toLocaleLowerCase().includes(query))
        : allOptions;
      const limit = settings.limit || 80;
      visibleOptions = matches.slice(0, limit);
      activeIndex = -1;
      input.removeAttribute("aria-activedescendant");
      heading.textContent = query
        ? `匹配名称 · ${matches.length}项`
        : `${settings.label || "可选名称"} · ${allOptions.length}项`;
      list.replaceChildren();

      if (!visibleOptions.length) {
        const empty = document.createElement("div");
        empty.className = "filter-preview-empty";
        empty.textContent = query ? "没有匹配的名称，仍可继续输入搜索" : "当前范围暂无可预览名称";
        list.append(empty);
        return;
      }

      visibleOptions.forEach((value, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "filter-preview-option";
        option.id = `${listId}-option-${index}`;
        option.setAttribute("role", "option");
        option.textContent = value;
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", () => choose(value));
        option.addEventListener("mousemove", () => setActive(index));
        list.append(option);
      });

      if (matches.length > limit) {
        const more = document.createElement("div");
        more.className = "filter-preview-more";
        more.textContent = `还有 ${matches.length - limit} 项，请输入关键词缩小范围`;
        list.append(more);
      }
    }

    function open() {
      clearTimeout(closeTimer);
      instances.forEach((instance) => { if (instance.input !== input) instance.close(); });
      renderOptions();
      menu.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    function close() {
      clearTimeout(closeTimer);
      menu.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      activeIndex = -1;
    }

    input.addEventListener("focus", open);
    input.addEventListener("click", open);
    input.addEventListener("input", () => { if (!menu.hidden) renderOptions(); });
    input.addEventListener("blur", () => { closeTimer = setTimeout(close, 120); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (menu.hidden) open();
        setActive(event.key === "ArrowDown" ? activeIndex + 1 : Math.max(0, activeIndex - 1));
      } else if (event.key === "Enter" && activeIndex >= 0 && visibleOptions[activeIndex]) {
        event.preventDefault();
        choose(visibleOptions[activeIndex]);
      } else if (event.key === "Escape") {
        close();
      } else if (event.key === "Tab") {
        close();
      }
    });

    const instance = { input, wrapper, close };
    instances.add(instance);
  }

  document.addEventListener("mousedown", (event) => {
    instances.forEach((instance) => {
      if (!instance.wrapper.contains(event.target)) instance.close();
    });
  });

  window.FilterPreview = { attach };
}());
