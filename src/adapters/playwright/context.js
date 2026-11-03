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

    const interactiveSelector = "a,button,input,select,textarea,[role='button'],[tabindex]";
    const interactiveNodes = [...document.body.querySelectorAll(interactiveSelector)]
      .filter((element) => visible(element) && getComputedStyle(element).pointerEvents !== "none")
      .slice(0, 300);

    const interactiveElements = interactiveNodes.map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        selector: selectorFor(element),
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        position: style.position,
        zIndex: style.zIndex,
        pointerEvents: style.pointerEvents,
        disabled: Boolean(element.disabled),
        visible: true
      };
    });

    const relatedNodes = (left, right) =>
      left === right || left.contains(right) || right.contains(left);
    const interactiveOverlaps = [];
    for (let leftIndex = 0; leftIndex < interactiveNodes.length; leftIndex += 1) {
      const leftNode = interactiveNodes[leftIndex];
      const leftRect = leftNode.getBoundingClientRect();
      const leftArea = leftRect.width * leftRect.height;
      if (leftArea < 1) continue;

      for (let rightIndex = leftIndex + 1; rightIndex < interactiveNodes.length; rightIndex += 1) {
        const rightNode = interactiveNodes[rightIndex];
        if (relatedNodes(leftNode, rightNode)) continue;
        const rightRect = rightNode.getBoundingClientRect();
        const rightArea = rightRect.width * rightRect.height;
        if (rightArea < 1) continue;

        const overlapLeft = Math.max(leftRect.left, rightRect.left, 0);
        const overlapTop = Math.max(leftRect.top, rightRect.top, 0);
        const overlapRight = Math.min(leftRect.right, rightRect.right, window.innerWidth);
        const overlapBottom = Math.min(leftRect.bottom, rightRect.bottom, window.innerHeight);
        const overlapWidth = Math.max(0, overlapRight - overlapLeft);
        const overlapHeight = Math.max(0, overlapBottom - overlapTop);
        const overlapArea = overlapWidth * overlapHeight;
        const smallerArea = Math.min(leftArea, rightArea);
        const overlapRatio = smallerArea > 0 ? overlapArea / smallerArea : 0;
        if (overlapArea < 16 || overlapRatio < 0.08) continue;

        const insetX = Math.min(2, overlapWidth * 0.1);
        const insetY = Math.min(2, overlapHeight * 0.1);
        const middleX = (overlapLeft + overlapRight) / 2;
        const middleY = (overlapTop + overlapBottom) / 2;
        const samplePoints = [
          [middleX, middleY],
          [overlapLeft + insetX, overlapTop + insetY],
          [overlapRight - insetX, overlapTop + insetY],
          [overlapLeft + insetX, overlapBottom - insetY],
          [overlapRight - insetX, overlapBottom - insetY]
        ];

        let leftWins = 0;
        let rightWins = 0;
        let leftBlockedByOther = 0;
        let rightBlockedByOther = 0;
        const externalBlockers = new Map();

        for (const [x, y] of samplePoints) {
          const stack = document.elementsFromPoint(x, y);
          const topElement = stack[0];
          if (!topElement) continue;

          const topControl = topElement.closest(interactiveSelector);
          if (topControl === leftNode || (topControl && leftNode.contains(topControl))) {
            leftWins += 1;
          } else if (topControl === rightNode || (topControl && rightNode.contains(topControl))) {
            rightWins += 1;
          } else {
            const topStyle = getComputedStyle(topElement);
            const blocksPointer = topStyle.pointerEvents !== "none" &&
              !relatedNodes(topElement, leftNode) && !relatedNodes(topElement, rightNode);
            if (blocksPointer) {
              const stackContainsLeft = stack.some((item) => item === leftNode || leftNode.contains(item));
              const stackContainsRight = stack.some((item) => item === rightNode || rightNode.contains(item));
              if (stackContainsLeft) leftBlockedByOther += 1;
              if (stackContainsRight) rightBlockedByOther += 1;
              if (stackContainsLeft || stackContainsRight) {
                const blocker = selectorFor(topElement);
                externalBlockers.set(blocker, (externalBlockers.get(blocker) ?? 0) + 1);
              }
            }
          }
        }

        let blockedSelector = null;
        let blockingSelector = null;
        let blockedSamples = 0;
        if (leftWins > rightWins) {
          blockedSelector = selectorFor(rightNode);
          blockingSelector = selectorFor(leftNode);
          blockedSamples = leftWins;
        } else if (rightWins > leftWins) {
          blockedSelector = selectorFor(leftNode);
          blockingSelector = selectorFor(rightNode);
          blockedSamples = rightWins;
        } else if (leftBlockedByOther > rightBlockedByOther && leftBlockedByOther > 0) {
          blockedSelector = selectorFor(leftNode);
          blockedSamples = leftBlockedByOther;
        } else if (rightBlockedByOther > leftBlockedByOther && rightBlockedByOther > 0) {
          blockedSelector = selectorFor(rightNode);
          blockedSamples = rightBlockedByOther;
        }
        if (blockedSelector && !blockingSelector && externalBlockers.size) {
          blockingSelector = [...externalBlockers.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }

        interactiveOverlaps.push({
          selectorA: selectorFor(leftNode),
          selectorB: selectorFor(rightNode),
          tagA: leftNode.tagName.toLowerCase(),
          tagB: rightNode.tagName.toLowerCase(),
          overlapAreaPx2: Math.round(overlapArea),
          overlapPercentOfSmallerTarget: Number((overlapRatio * 100).toFixed(1)),
          blockedSelector,
          blockingSelector,
          blockedSampleRatio: Number((blockedSamples / samplePoints.length).toFixed(2)),
          sampleCount: samplePoints.length,
          positionA: getComputedStyle(leftNode).position,
          positionB: getComputedStyle(rightNode).position,
          zIndexA: getComputedStyle(leftNode).zIndex,
          zIndexB: getComputedStyle(rightNode).zIndex
        });
      }
    }

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
      interactiveOverlaps,
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
