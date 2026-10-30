export async function collectPageContext(page, { thresholds = {} } = {}) {
  return page.evaluate((settings) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };

    const selectorFor = (element) => {
      if (element.id) return "#" + CSS.escape(element.id);
      const classes = [...element.classList].slice(0, 2);
      return element.tagName.toLowerCase() +
        (classes.length ? "." + classes.map((name) => CSS.escape(name)).join(".") : "");
    };
    const textOf = (element) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

    const elements = [...document.body.querySelectorAll("*")].filter(visible).slice(0, 1500).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        selector: selectorFor(element),
        tagName: element.tagName.toLowerCase(),
        right: rect.right,
        width: rect.width,
        height: rect.height,
        fixedWidth: (/^(?:\d+(?:\.\d+)?)(?:px|rem|em)$/.test(element.style.width) ||
          /^\d+$/.test(element.getAttribute("width") ?? "")),
        visible: true
      };
    });

    const textElements = [...document.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,a,button,label,small,li,span")]
      .filter(visible).slice(0, 1000).map((element) => ({
        selector: selectorFor(element),
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
        visible: true
      }));

    const interactiveElements = [...document.body.querySelectorAll("a,button,input,select,textarea,[role='button'],[tabindex]")]
      .filter(visible).slice(0, 500).map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector: selectorFor(element),
          width: rect.width,
          height: rect.height,
          visible: true
        };
      });

    const verticalGaps = [];
    const candidates = [...document.body.children].filter(visible).slice(0, 100);
    for (let index = 1; index < candidates.length; index += 1) {
      const previous = candidates[index - 1].getBoundingClientRect();
      const current = candidates[index].getBoundingClientRect();
      const gap = current.top - previous.bottom;
      if (gap > 0) verticalGaps.push({
        selector: selectorFor(candidates[index]),
        height: gap,
        containsContent: false,
        visible: true
      });
    }

    const images = [...document.images].slice(0, 500).map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        selector: selectorFor(image),
        hasAlt: image.hasAttribute("alt"),
        alt: image.getAttribute("alt"),
        hasWidth: image.hasAttribute("width") || image.style.width !== "",
        hasHeight: image.hasAttribute("height") || image.style.height !== "",
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        renderedWidth: rect.width,
        renderedHeight: rect.height,
        visible: visible(image)
      };
    });

    const formControls = [...document.querySelectorAll("input,select,textarea")]
      .filter(visible).slice(0, 300).map((control) => ({
        selector: selectorFor(control),
        tagName: control.tagName.toLowerCase(),
        type: control.getAttribute("type") ?? "text",
        labelsText: [...(control.labels ?? [])].map(textOf).join(" ").trim(),
        ariaLabel: control.getAttribute("aria-label"),
        ariaLabelledByText: (control.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/).filter(Boolean)
          .map((id) => textOf(document.getElementById(id))).join(" ").trim(),
        title: control.getAttribute("title"),
        visible: true
      }));

    const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
      .filter(visible).map((heading) => ({
        level: Number(heading.tagName.slice(1)),
        selector: selectorFor(heading),
        text: textOf(heading).slice(0, 120)
      }));

    const resources = performance.getEntriesByType("resource").slice(0, 500).map((entry) => ({
      name: entry.name,
      durationMs: entry.duration,
      transferSize: Number(entry.transferSize ?? 0),
      encodedBodySize: Number(entry.encodedBodySize ?? 0),
      initiatorType: entry.initiatorType
    }));

    const cards = [...document.querySelectorAll(
      "[data-qa-card],[data-card],.product-card,.product-item,.catalog-item"
    )].slice(0, 100).map((card) => {
      const cardImages = [...card.querySelectorAll("img")].filter(visible);
      const buttons = [...card.querySelectorAll("button,a,[role='button']")].filter(visible);
      return {
        selector: selectorFor(card),
        imageRatios: cardImages.map((image) => {
          const rect = image.getBoundingClientRect();
          return rect.height > 0 ? rect.width / rect.height : null;
        }).filter((ratio) => Number.isFinite(ratio) && ratio > 0),
        buttonHeights: buttons.map((button) => button.getBoundingClientRect().height)
          .filter((height) => Number.isFinite(height) && height > 0)
      };
    });

    return {
      url: location.href,
      title: document.title,
      documentLang: document.documentElement.getAttribute("lang") ?? "",
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentScrollWidth: document.documentElement.scrollWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      domNodeCount: document.getElementsByTagName("*").length,
      elements,
      textElements,
      interactiveElements,
      verticalGaps,
      images,
      formControls,
      headings,
      resources,
      cards,
      thresholds: settings.thresholds
    };
  }, { thresholds });
}
