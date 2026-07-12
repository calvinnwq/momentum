/* Momentum docs - chrome rendered from one manifest. */
(function () {
  "use strict";

  var NAV = [
    {
      title: "Start",
      items: [
        { n: "01", t: "Overview", h: "index.html" },
        { n: "02", t: "Walkthrough", h: "walkthrough.html" }
      ]
    },
    {
      title: "Workflow runtime",
      items: [
        { n: "03", t: "Workflow commands", h: "workflow-commands.html" },
        { n: "04", t: "OpenClaw supervise", h: "openclaw-supervise.html" },
        { n: "05", t: "Daemon", h: "daemon.html" },
        { n: "06", t: "Recovery", h: "recovery.html" },
        { n: "07", t: "Doctor", h: "doctor.html" },
        { n: "08", t: "Data directory", h: "data-directory.html" }
      ]
    },
    {
      title: "External state",
      items: [
        { n: "09", t: "Source commands", h: "source-commands.html" },
        { n: "10", t: "Evidence commands", h: "evidence-commands.html" },
        { n: "11", t: "Intent commands", h: "intent-commands.html" }
      ]
    },
    {
      title: "Extend",
      items: [
        { n: "12", t: "Executor SDK", h: "executor-sdk.html" }
      ]
    },
    {
      title: "Goal-lane compatibility",
      items: [
        { n: "13", t: "Goal spec", h: "goal-spec.html" },
        { n: "14", t: "Runners", h: "runners.html" },
        { n: "15", t: "Failure and reset", h: "failure-reset.html" }
      ]
    }
  ];

  var ORDER = [];
  NAV.forEach(function (group) {
    group.items.forEach(function (item) {
      if (!item.ext) ORDER.push(item);
    });
  });

  var page = document.body.dataset.page || "index.html";
  var THEME_KEY = "momentum-docs-theme";

  function getStorageItem(storageName, key) {
    try { return window[storageName].getItem(key); } catch (_) { return null; }
  }

  function setStorageItem(storageName, key, value) {
    try { window[storageName].setItem(key, value); } catch (_) {}
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
      button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    });
  }

  function navLink(item) {
    var link = document.createElement("a");
    link.href = item.h;
    if (item.ext) {
      link.className = "ext";
      link.rel = "noopener";
    }
    if (item.h === page) link.setAttribute("aria-current", "page");
    if (item.n) {
      var number = document.createElement("span");
      number.className = "n";
      number.textContent = item.n;
      link.appendChild(number);
    }
    link.appendChild(document.createTextNode(item.t));
    return link;
  }

  function renderSidebar() {
    var nav = document.getElementById("sidebar");
    if (!nav) return;
    NAV.forEach(function (group) {
      var box = document.createElement("div");
      box.className = "nav-group";
      var heading = document.createElement("p");
      heading.className = "nav-group-title";
      heading.textContent = group.title;
      box.appendChild(heading);
      group.items.forEach(function (item) {
        box.appendChild(navLink(item));
      });
      nav.appendChild(box);
    });
  }

  function renderPager() {
    var el = document.getElementById("pager");
    if (!el) return;
    var idx = ORDER.findIndex(function (item) { return item.h === page; });
    if (idx < 0) return;
    var prev = ORDER[idx - 1];
    var next = ORDER[idx + 1];
    el.innerHTML = "";
    [
      ["prev", prev, "<- Previous"],
      ["next", next, "Next ->"]
    ].forEach(function (def) {
      if (!def[1]) {
        el.appendChild(document.createElement("span"));
        return;
      }
      var link = document.createElement("a");
      link.className = def[0];
      link.href = def[1].h;
      link.innerHTML = '<span class="dir">' + def[2] + '</span><span class="t">' + def[1].t + "</span>";
      el.appendChild(link);
    });
  }

  function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function renderToc() {
    var toc = document.getElementById("toc");
    var headings = document.querySelectorAll("article h2, article h3");
    var links = [];
    headings.forEach(function (heading) {
      if (!heading.id) heading.id = slug(heading.textContent);
      var anchor = document.createElement("a");
      anchor.href = "#" + heading.id;
      anchor.textContent = "#";
      anchor.className = "anchor";
      anchor.setAttribute("aria-label", "Link to " + heading.textContent);
      heading.appendChild(anchor);
      if (toc) {
        var tocLink = document.createElement("a");
        tocLink.href = "#" + heading.id;
        tocLink.textContent = heading.childNodes[0].textContent.trim();
        if (heading.tagName === "H3") tocLink.className = "sub";
        toc.appendChild(tocLink);
        links.push({ head: heading, link: tocLink });
      }
    });
    if (!links.length) return;

    function spy() {
      var current = links[0];
      links.forEach(function (entry) {
        if (entry.head.getBoundingClientRect().top <= 120) current = entry;
      });
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        current = links[links.length - 1];
      }
      links.forEach(function (entry) {
        entry.link.classList.toggle("active", entry === current);
      });
    }

    window.addEventListener("scroll", spy, { passive: true });
    window.addEventListener("resize", spy, { passive: true });
    spy();
  }

  function renderCopyButtons() {
    document.querySelectorAll("article pre").forEach(function (pre) {
      var wrap = document.createElement("div");
      wrap.className = "snippet";
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      var button = document.createElement("button");
      button.className = "copy-btn";
      button.type = "button";
      button.textContent = "copy";
      button.addEventListener("click", function () {
        navigator.clipboard.writeText(pre.textContent.trim()).then(function () {
          button.textContent = "copied";
          button.classList.add("done");
          setTimeout(function () {
            button.textContent = "copy";
            button.classList.remove("done");
          }, 1400);
        });
      });
      wrap.appendChild(button);
    });
  }

  function flattenSearchItems() {
    var items = [];
    NAV.forEach(function (group) {
      group.items.forEach(function (item) {
        if (!item.ext) {
          items.push({
            title: item.t,
            href: item.h,
            where: group.title,
            text: [item.t, group.title, item.h.replace(/[-.]/g, " ")].join(" ").toLowerCase()
          });
        }
      });
    });
    return items;
  }

  function openPalette() {
    if (document.querySelector(".palette")) return;
    var items = flattenSearchItems();
    var backdrop = document.createElement("div");
    backdrop.className = "palette-backdrop";
    var palette = document.createElement("div");
    palette.className = "palette";
    palette.setAttribute("role", "dialog");
    palette.setAttribute("aria-label", "Search docs");
    palette.innerHTML = '<input type="search" placeholder="Search docs..." aria-label="Search docs"><div class="palette-results"></div>';
    document.body.appendChild(backdrop);
    document.body.appendChild(palette);
    var input = palette.querySelector("input");
    var results = palette.querySelector(".palette-results");

    function close() {
      backdrop.remove();
      palette.remove();
    }

    function render() {
      var q = input.value.trim().toLowerCase();
      var matches = (q ? items.filter(function (item) { return item.text.indexOf(q) >= 0; }) : items).slice(0, 12);
      results.innerHTML = "";
      if (!matches.length) {
        var empty = document.createElement("div");
        empty.className = "palette-empty";
        empty.textContent = "No matching docs page.";
        results.appendChild(empty);
        return;
      }
      matches.forEach(function (item, idx) {
        var link = document.createElement("a");
        link.href = item.href;
        if (idx === 0) link.className = "active";
        link.innerHTML = '<span>' + item.title + '</span><span class="where">' + item.where + "</span>";
        results.appendChild(link);
      });
    }

    backdrop.addEventListener("click", close);
    input.addEventListener("input", render);
    palette.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
      if (event.key === "Enter") {
        var first = results.querySelector("a");
        if (first) window.location.href = first.href;
      }
    });
    render();
    setTimeout(function () { input.focus(); }, 0);
  }

  document.addEventListener("click", function (event) {
    if (event.target.closest("[data-theme-toggle]")) {
      var next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      setStorageItem("localStorage", THEME_KEY, next);
      applyTheme(next);
      return;
    }

    var menuButton = event.target.closest("[data-menu]");
    if (menuButton) {
      var open = document.body.classList.toggle("nav-open");
      menuButton.setAttribute("aria-expanded", open ? "true" : "false");
      return;
    }

    if (event.target.closest("[data-search-open]")) {
      openPalette();
      return;
    }

    if (document.body.classList.contains("nav-open") && event.target.closest(".sidebar a")) {
      document.body.classList.remove("nav-open");
      var activeMenu = document.querySelector("[data-menu]");
      if (activeMenu) activeMenu.setAttribute("aria-expanded", "false");
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "/" && !/^(input|textarea|select)$/i.test(event.target.tagName)) {
      event.preventDefault();
      openPalette();
    }
    if (event.key === "Escape" && document.body.classList.contains("nav-open")) {
      document.body.classList.remove("nav-open");
      var activeMenu = document.querySelector("[data-menu]");
      if (activeMenu) activeMenu.setAttribute("aria-expanded", "false");
    }
  });

  renderSidebar();
  renderPager();
  renderToc();
  renderCopyButtons();
  applyTheme(getStorageItem("localStorage", THEME_KEY) || document.documentElement.dataset.theme || "light");
})();
