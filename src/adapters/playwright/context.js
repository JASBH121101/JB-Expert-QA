export async function collectPageContext(page, { thresholds = {} } = {}) {
  return page.evaluate((settings) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };

    const selectorFor = (element) => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const classes = [...element.classList].slice(0, 2);
      return element.tagName.toLowerCase() +
        (classes.length ? "." + classes.map((name) => CSS.escape(name)).join(".") : "");
    };

    const elements = [...document.body.querySelectorAll("*")]
      .filter(visible)
      .slice(0, 1500)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          selector: selectorFor(element),
          tagName: element.tagName.toLowerCase(),
          right: rect.right,
          width: rect.width,
          height: rect.height,
          fixedWidth: (/^(?:\\d+(?:\\.\\d+)?)(?:px|rem|em)$/.test(element.style.width) ||
            /^\\d+$/.test(element.getAttribute("width") ?? "")),
          visible: true
        };
      });

    const textElements = [...document.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,a,button,label,small,li,span")]
      .filter(visible)
      .slice(0, 1000)
      .map((element) => ({
        selector: selectorFor(element),
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
        visible: true
      }));

    const interactiveElements = [...document.body.querySelectorAll("a,button,input,select,textarea,[role='button'],[tabindex]")]
      .filter(visible)
      .slice(0, 500)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector: selectorFor(element),
          width: rect.width,
          height: rect.height,
          visible: true
        };
      });

    const verticalGaps = [];
    const candidates = [...document.body.children]
      .filter(visible)
      .slice(0, 100);
    for (let index = 1; index < candidates.length; index += 1) {
      const previous = candidates[index - 1].getBoundingClientRect();
      const current = candidates[index].getBoundingClientRect();
      const gap = current.top - previous.bottom;
      if (gap > 0) {
        verticalGaps.push({
          selector: selectorFor(candidates[index]),
          height: gap,
          containsContent: false,
          visible: true
        });
      }
    }

    return {
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentScrollWidth: document.documentElement.scrollWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      elements,
      textElements,
      interactiveElements,
      verticalGaps,
      thresholds: settings.thresholds
    };
  }, { thresholds });
}
