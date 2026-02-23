import { emit } from '@tauri-apps/api/event'; // For emitting the response
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow'; // For window-specific listener

// Track the unlisten functions for cleanup
let domContentUnlistenFunction: (() => void) | null = null;
let pageMapUnlistenFunction: (() => void) | null = null;
let localStorageUnlistenFunction: (() => void) | null = null;
let jsExecutionUnlistenFunction: (() => void) | null = null;
let elementPositionUnlistenFunction: (() => void) | null = null;
let sendTextToElementUnlistenFunction: (() => void) | null = null;
let getPageStateUnlistenFunction: (() => void) | null = null;
let navigateBackUnlistenFunction: (() => void) | null = null;
let scrollPageUnlistenFunction: (() => void) | null = null;
let fillFormUnlistenFunction: (() => void) | null = null;
let waitForUnlistenFunction: (() => void) | null = null;

// Global ref map: stores numbered references to interactive elements from the last getPageMap call
let _pageMapRefElements: Map<number, Element> = new Map();

// Delta tracking: fingerprint → { ref, props } from the previous getPageMap(delta:true) call
let _previousPageMapFingerprints: Map<string, { ref: number; props: PageMapElement }> = new Map();
let _previousPageMapMaxRef: number = 0;

export async function setupPluginListeners() { 
    const currentWindow: WebviewWindow = getCurrentWebviewWindow();
    domContentUnlistenFunction = await currentWindow.listen('got-dom-content', handleDomContentRequest);
    pageMapUnlistenFunction = await currentWindow.listen('get-page-map', handleGetPageMapRequest);
    localStorageUnlistenFunction = await currentWindow.listen('get-local-storage', handleLocalStorageRequest);
    jsExecutionUnlistenFunction = await currentWindow.listen('execute-js', handleJsExecutionRequest);
    elementPositionUnlistenFunction = await currentWindow.listen('get-element-position', handleGetElementPositionRequest);
    sendTextToElementUnlistenFunction = await currentWindow.listen('send-text-to-element', handleSendTextToElementRequest);
    getPageStateUnlistenFunction = await currentWindow.listen('get-page-state', handleGetPageStateRequest);
    navigateBackUnlistenFunction = await currentWindow.listen('navigate-back', handleNavigateBackRequest);
    scrollPageUnlistenFunction = await currentWindow.listen('scroll-page', handleScrollPageRequest);
    fillFormUnlistenFunction = await currentWindow.listen('fill-form', handleFillFormRequest);
    waitForUnlistenFunction = await currentWindow.listen('wait-for', handleWaitForRequest);

    console.log('TAURI-PLUGIN-MCP: All event listeners are set up on the current window.');
}

export async function cleanupPluginListeners() {
    if (domContentUnlistenFunction) {
        domContentUnlistenFunction();
        domContentUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "got-dom-content" has been removed.');
    }
    
    if (pageMapUnlistenFunction) {
        pageMapUnlistenFunction();
        pageMapUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "get-page-map" has been removed.');
    }

    if (localStorageUnlistenFunction) {
        localStorageUnlistenFunction();
        localStorageUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "get-local-storage" has been removed.');
    }

    if (jsExecutionUnlistenFunction) {
        jsExecutionUnlistenFunction();
        jsExecutionUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "execute-js" has been removed.');
    }
    
    if (elementPositionUnlistenFunction) {
        elementPositionUnlistenFunction();
        elementPositionUnlistenFunction = null;
        console.log('TAURI-PLUGIN-MCP: Event listener for "get-element-position" has been removed.');
    }
    
    if (sendTextToElementUnlistenFunction) {
        sendTextToElementUnlistenFunction();
        sendTextToElementUnlistenFunction = null;
    }
    if (getPageStateUnlistenFunction) {
        getPageStateUnlistenFunction();
        getPageStateUnlistenFunction = null;
    }
    if (navigateBackUnlistenFunction) {
        navigateBackUnlistenFunction();
        navigateBackUnlistenFunction = null;
    }
    if (scrollPageUnlistenFunction) {
        scrollPageUnlistenFunction();
        scrollPageUnlistenFunction = null;
    }
    if (fillFormUnlistenFunction) {
        fillFormUnlistenFunction();
        fillFormUnlistenFunction = null;
    }
    if (waitForUnlistenFunction) {
        waitForUnlistenFunction();
        waitForUnlistenFunction = null;
    }
    console.log('TAURI-PLUGIN-MCP: All event listeners have been removed.');
}

async function handleGetElementPositionRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received get-element-position, payload:', event.payload);

    try {
        const { selectorType, selectorValue, shouldClick = false } = event.payload;

        // Find the element based on the selector type
        let element = null;
        let debugInfo = [];

        switch (selectorType) {
            case 'ref':
                // Look up by numbered reference from get_page_map
                const refNum = parseInt(selectorValue, 10);
                element = getElementByRef(refNum);
                if (!element) {
                    debugInfo.push(`No element found with ref=${refNum}. Call get_page_map first to populate refs.`);
                }
                break;
            case 'id':
                element = document.getElementById(selectorValue);
                if (!element) {
                    debugInfo.push(`No element found with id="${selectorValue}"`);
                }
                break;
            case 'class':
                // Get the first element with the class
                const elemsByClass = document.getElementsByClassName(selectorValue);
                element = elemsByClass.length > 0 ? elemsByClass[0] : null;
                if (!element) {
                    debugInfo.push(`No elements found with class="${selectorValue}" (total matching: 0)`);
                } else if (elemsByClass.length > 1) {
                    debugInfo.push(`Found ${elemsByClass.length} elements with class="${selectorValue}", using the first one`);
                }
                break;
            case 'tag':
                // Get the first element with the tag name
                const elemsByTag = document.getElementsByTagName(selectorValue);
                element = elemsByTag.length > 0 ? elemsByTag[0] : null;
                if (!element) {
                    debugInfo.push(`No elements found with tag="${selectorValue}" (total matching: 0)`);
                } else if (elemsByTag.length > 1) {
                    debugInfo.push(`Found ${elemsByTag.length} elements with tag="${selectorValue}", using the first one`);
                }
                break;
            case 'text':
                // Find element by text content
                element = findElementByText(selectorValue);
                if (!element) {
                    debugInfo.push(`No element found with text="${selectorValue}"`);
                    // Check if any element contains part of the text (for debugging)
                    const containingElements = Array.from(document.querySelectorAll('*'))
                        .filter(el => el.textContent && el.textContent.includes(selectorValue));

                    if (containingElements.length > 0) {
                        debugInfo.push(`Found ${containingElements.length} elements containing part of the text.`);
                        debugInfo.push(`First element with partial match: ${containingElements[0].tagName}, text="${containingElements[0].textContent?.trim()}"`);
                    }

                    // Check for similar inputs
                    const inputs = Array.from(document.querySelectorAll('input, textarea'));
                    const inputsWithSimilarPlaceholders = inputs
                        .filter(input =>
                            (input as HTMLInputElement).placeholder &&
                            (input as HTMLInputElement).placeholder.includes(selectorValue)
                        );

                    if (inputsWithSimilarPlaceholders.length > 0) {
                        debugInfo.push(`Found ${inputsWithSimilarPlaceholders.length} input elements with similar placeholders.`);
                        const firstMatch = inputsWithSimilarPlaceholders[0] as HTMLInputElement;
                        debugInfo.push(`First input with similar placeholder: ${firstMatch.tagName}, placeholder="${firstMatch.placeholder}"`);
                    }
                }
                break;
            default:
                throw new Error(`Unsupported selector type: ${selectorType}`);
        }
        
        if (!element) {
            throw new Error(`Element with ${selectorType}="${selectorValue}" not found. ${debugInfo.join(' ')}`);
        }
        
        // Get element position
        const rect = element.getBoundingClientRect();
        console.log('TAURI-PLUGIN-MCP: Element rect:', { 
            left: rect.left, 
            top: rect.top, 
            right: rect.right, 
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height
        });

        // Calculate center of the element in viewport-relative CSS pixels
        const elementViewportCssX = rect.left + (rect.width / 2);
        const elementViewportCssY = rect.top + (rect.height / 2);

        // Account for Webview Scrolling (CSS Pixels)
        const elementDocumentCssX = elementViewportCssX + window.scrollX;
        const elementDocumentCssY = elementViewportCssY + window.scrollY;
        
        // Always return the raw document coordinates (ideal for mouse_movement)
        const targetX = elementDocumentCssX;
        const targetY = elementDocumentCssY;
        
        console.log('TAURI-PLUGIN-MCP: Raw coordinates for mouse_movement:', { x: targetX, y: targetY });

        // Click the element if requested
        let clickResult = null;
        if (shouldClick) {
            clickResult = clickElement(element, elementViewportCssX, elementViewportCssY);
        }

        await emit('get-element-position-response', {
            success: true,
            data: {
                x: targetX,
                y: targetY,
                element: {
                    tag: element.tagName,
                    classes: element.className,
                    id: element.id,
                    text: element.textContent?.trim() || '',
                    placeholder: element instanceof HTMLInputElement ? element.placeholder : undefined
                },
                clicked: shouldClick,
                clickResult,
                debug: {
                    elementRect: rect,
                    viewportCenter: {
                        x: elementViewportCssX,
                        y: elementViewportCssY
                    },
                    documentCenter: {
                        x: elementDocumentCssX,
                        y: elementDocumentCssY
                    },
                    window: {
                        innerSize: {
                            width: window.innerWidth,
                            height: window.innerHeight
                        },
                        scrollPosition: {
                            x: window.scrollX,
                            y: window.scrollY
                        }
                    }
                }
            }
        });

    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling get-element-position request', error);
        await emit('get-element-position-response', {
            success: false,
            error: error instanceof Error ? error.toString() : String(error)
        }).catch(e => console.error('TAURI-PLUGIN-MCP: Error emitting error response', e));
    }
}

// Helper function to find an element by its text content
function findElementByText(text: string): Element | null {
    // Get all elements in the document
    const allElements = document.querySelectorAll('*');
    
    // First try exact text content matching
    for (const element of allElements) {
        // Check exact text content
        if (element.textContent && element.textContent.trim() === text) {
            return element;
        }
        
        // Check placeholder attribute (for input fields)
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            if (element.placeholder === text) {
                return element;
            }
        }
        
        // Check title attribute
        if (element.getAttribute('title') === text) {
            return element;
        }
        
        // Check aria-label attribute
        if (element.getAttribute('aria-label') === text) {
            return element;
        }
    }
    
    // If no exact match, try partial text content matching
    for (const element of allElements) {
        // Check if text is contained within the element's text
        if (element.textContent && element.textContent.trim().includes(text)) {
            return element;
        }
        
        // Check if text is contained within placeholder
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            if (element.placeholder && element.placeholder.includes(text)) {
                return element;
            }
        }
        
        // Check partial match in title attribute
        const title = element.getAttribute('title');
        if (title && title.includes(text)) {
            return element;
        }
        
        // Check partial match in aria-label attribute
        const ariaLabel = element.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.includes(text)) {
            return element;
        }
    }
    
    return null;
}

// Helper function to click an element
function clickElement(element: Element, centerX: number, centerY: number) {
    try {
        // Create and dispatch mouse events
        const mouseDown = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: centerX,
            clientY: centerY
        });
        
        const mouseUp = new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: centerX,
            clientY: centerY
        });
        
        const click = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: centerX,
            clientY: centerY
        });
        
        // Dispatch the events
        element.dispatchEvent(mouseDown);
        element.dispatchEvent(mouseUp);
        element.dispatchEvent(click);
        
        return {
            success: true,
            elementTag: element.tagName,
            position: { x: centerX, y: centerY }
        };
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error clicking element:', error);
        return {
            success: false,
            error: error instanceof Error ? error.toString() : String(error)
        };
    }
}

async function handleDomContentRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received got-dom-content, payload:', event.payload);
    
    try {
        const domContent = getDomContent();
        await emit('got-dom-content-response', domContent);
        console.log('TAURI-PLUGIN-MCP: Emitted got-dom-content-response');
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling dom content request', error);
        await emit('got-dom-content-response', '').catch(e => 
            console.error('TAURI-PLUGIN-MCP: Error emitting empty response', e)
        );
    }
}

function getDomContent(): string {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        const domContent = document.documentElement.outerHTML;
        console.log('TAURI-PLUGIN-MCP: DOM content fetched, length:', domContent.length);
        return domContent;
    } 
    
    console.warn('TAURI-PLUGIN-MCP: DOM not fully loaded when got-dom-content received. Returning empty content.');
    return '';
}

// --- Page Map (smart DOM serializer) ---

interface PageMapElement {
    ref: number;
    tag: string;
    type?: string;
    text?: string;
    placeholder?: string;
    ariaLabel?: string;
    role?: string;
    href?: string;
    name?: string;
    id?: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
    options?: string[];
}

interface PageMapOptions {
    includeContent?: boolean;
    interactiveOnly?: boolean;
    scopeSelector?: string | string[];
    maxDepth?: number;
    delta?: boolean;
    waitForStable?: boolean;
    quietMs?: number;
    maxWaitMs?: number;
}

interface PageMapDelta {
    added: number[];
    removed: number[];
    changed: number[];
}

interface PageMapResult {
    url: string;
    title: string;
    viewport: { width: number; height: number };
    elements: PageMapElement[];
    content: string;
    scope?: string | string[];
    maxDepth?: number;
    delta?: PageMapDelta;
}

// Wait for DOM mutations to settle (no changes for `quietMs` milliseconds)
function waitForDomStable(quietMs: number = 300, maxWaitMs: number = 3000): Promise<void> {
    return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const timeout = setTimeout(() => {
            observer.disconnect();
            resolve();
        }, maxWaitMs);

        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                observer.disconnect();
                clearTimeout(timeout);
                resolve();
            }, quietMs);
        });

        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
        });

        // If no mutations happen at all, resolve after quietMs
        timer = setTimeout(() => {
            observer.disconnect();
            clearTimeout(timeout);
            resolve();
        }, quietMs);
    });
}

async function handleGetPageMapRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received get-page-map, payload:', event.payload);

    try {
        const options = typeof event.payload === 'object' ? event.payload : {};

        // If wait_for_stable is requested, wait for DOM to settle first
        if (options.waitForStable) {
            const quietMs = typeof options.quietMs === 'number' ? options.quietMs : 300;
            const maxWaitMs = typeof options.maxWaitMs === 'number' ? options.maxWaitMs : 3000;
            console.log(`TAURI-PLUGIN-MCP: Waiting for DOM to stabilize (quiet=${quietMs}ms, max=${maxWaitMs}ms)`);
            await waitForDomStable(quietMs, maxWaitMs);
        }

        const result = getPageMap(options);
        await emit('get-page-map-response', JSON.stringify(result));
        console.log('TAURI-PLUGIN-MCP: Emitted get-page-map-response');
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling get-page-map request', error);
        await emit('get-page-map-response', JSON.stringify({
            url: window.location.href,
            title: document.title,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            elements: [],
            content: '',
            error: error instanceof Error ? error.message : String(error)
        })).catch(e =>
            console.error('TAURI-PLUGIN-MCP: Error emitting error response', e)
        );
    }
}

const NOISE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'HEAD', 'BR', 'HR',
    'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SLOT'
]);

const INTERACTIVE_TAGS = new Set([
    'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY'
]);

const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'switch', 'slider',
    'spinbutton', 'combobox', 'listbox', 'option', 'menuitem', 'tab',
    'searchbox'
]);

function isElementVisible(el: Element): boolean {
    if (!(el instanceof HTMLElement)) return true;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
}

function isInteractive(el: Element): boolean {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    if (el.getAttribute('tabindex') !== null && el.getAttribute('tabindex') !== '-1') return true;
    if (el.getAttribute('onclick') || el.getAttribute('ng-click') || el.getAttribute('@click')) return true;
    return false;
}

function getElementText(el: Element): string {
    // For inputs, return value or placeholder
    if (el instanceof HTMLInputElement) {
        return el.value || el.placeholder || '';
    }
    if (el instanceof HTMLTextAreaElement) {
        return el.value || el.placeholder || '';
    }
    // For selects, return selected option text
    if (el instanceof HTMLSelectElement) {
        return el.options[el.selectedIndex]?.text || '';
    }
    // For other elements, get direct text (not children's text)
    let text = '';
    for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent || '';
        }
    }
    text = text.trim();
    // If no direct text, fall back to aria-label or title
    if (!text) {
        text = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    }
    // Truncate long text
    if (text.length > 100) {
        text = text.substring(0, 97) + '...';
    }
    return text;
}

// Compute a stable fingerprint for an element to identify it across delta calls
function elementFingerprint(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const id = el.id || '';
    const name = (el as HTMLInputElement).name || '';
    const type = (el as HTMLInputElement).type || '';
    const href = (el as HTMLAnchorElement).href || '';
    return `${tag}|${id}|${name}|${type}|${href}`;
}

function getPageMap(options?: PageMapOptions): PageMapResult {
    const interactiveOnly = options?.interactiveOnly === true;
    const includeContent = interactiveOnly ? false : (options?.includeContent !== false);
    const maxDepth = typeof options?.maxDepth === 'number' ? options.maxDepth : Infinity;
    const isDelta = options?.delta === true;
    const scopeSelector = options?.scopeSelector;

    // Clear previous ref map
    _pageMapRefElements.clear();

    const elements: PageMapElement[] = [];
    // In delta mode, start refs above the previous max so new elements get high refs
    let refCounter = isDelta ? _previousPageMapMaxRef + 1 : 1;
    const contentParts: string[] = [];
    const seenTexts = new Set<string>();

    // Track fingerprints for this call (used by delta mode)
    const currentFingerprints: Map<string, { ref: number; props: PageMapElement }> = new Map();

    function assignRef(el: Element, entry: PageMapElement): number {
        if (isDelta) {
            const fp = elementFingerprint(el);
            const prev = _previousPageMapFingerprints.get(fp);
            if (prev) {
                // Reuse the old ref for this fingerprint
                entry.ref = prev.ref;
                _pageMapRefElements.set(prev.ref, el);
                currentFingerprints.set(fp, { ref: prev.ref, props: entry });
                return prev.ref;
            }
        }
        // New element (or non-delta mode): assign next ref
        const ref = refCounter++;
        entry.ref = ref;
        _pageMapRefElements.set(ref, el);
        if (isDelta) {
            currentFingerprints.set(elementFingerprint(el), { ref, props: entry });
        }
        return ref;
    }

    function walkNode(node: Node, depth: number) {
        // Depth guard: stop recursing deeper than maxDepth
        if (depth > maxDepth) return;

        if (node.nodeType === Node.TEXT_NODE) {
            // In interactive-only mode, skip all text collection
            if (interactiveOnly) return;
            const text = (node.textContent || '').trim();
            if (includeContent && text && !seenTexts.has(text)) {
                seenTexts.add(text);
                contentParts.push(text);
            }
            return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as Element;

        // Skip noise tags
        if (NOISE_TAGS.has(el.tagName)) return;

        // Skip SVG internals (keep the top-level <svg> but skip its children)
        if (el.tagName === 'SVG' || el.closest('svg')) {
            // If this is the <svg> itself, check for aria-label
            if (el.tagName === 'svg' || el.tagName === 'SVG') {
                const label = el.getAttribute('aria-label');
                if (label && isElementVisible(el)) {
                    const entry: PageMapElement = {
                        ref: 0,
                        tag: 'svg',
                        ariaLabel: label
                    };
                    assignRef(el, entry);
                    elements.push(entry);
                }
            }
            return;
        }

        // Skip hidden elements
        if (!isElementVisible(el)) return;

        // Check if interactive
        if (isInteractive(el)) {
            const entry: PageMapElement = {
                ref: 0,
                tag: el.tagName.toLowerCase(),
            };

            // Type for inputs
            if (el instanceof HTMLInputElement) {
                entry.type = el.type;
                if (el.value) entry.value = el.value.substring(0, 100);
                if (el.placeholder) entry.placeholder = el.placeholder;
                if (el.name) entry.name = el.name;
                if (el.type === 'checkbox' || el.type === 'radio') {
                    entry.checked = el.checked;
                }
                if (el.disabled) entry.disabled = true;
            } else if (el instanceof HTMLTextAreaElement) {
                entry.type = 'textarea';
                if (el.value) entry.value = el.value.substring(0, 100);
                if (el.placeholder) entry.placeholder = el.placeholder;
                if (el.name) entry.name = el.name;
                if (el.disabled) entry.disabled = true;
            } else if (el instanceof HTMLSelectElement) {
                entry.type = 'select';
                entry.options = Array.from(el.options).map(o => o.text).slice(0, 10);
                if (el.name) entry.name = el.name;
                if (el.disabled) entry.disabled = true;
            } else if (el instanceof HTMLAnchorElement) {
                entry.href = el.href;
            }

            const text = getElementText(el);
            if (text) entry.text = text;

            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel && ariaLabel !== text) entry.ariaLabel = ariaLabel;

            const role = el.getAttribute('role');
            if (role) entry.role = role;

            if (el.id) entry.id = el.id;

            assignRef(el, entry);
            elements.push(entry);
        }

        // Walk children
        for (const child of el.childNodes) {
            walkNode(child, depth + 1);
        }
    }

    // Scope-aware root selection
    const roots: Element[] = [];
    if (scopeSelector) {
        const selectors = Array.isArray(scopeSelector) ? scopeSelector : [scopeSelector];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) roots.push(el);
        }
    }
    if (roots.length === 0) {
        roots.push(document.body || document.documentElement);
    }
    for (const root of roots) {
        walkNode(root, 0);
    }

    // Delta metadata
    let deltaResult: PageMapDelta | undefined;
    if (isDelta) {
        const added: number[] = [];
        const removed: number[] = [];
        const changed: number[] = [];

        // Find added & changed
        for (const [fp, cur] of currentFingerprints) {
            const prev = _previousPageMapFingerprints.get(fp);
            if (!prev) {
                added.push(cur.ref);
            } else {
                // Compare props (excluding ref) to detect changes
                const curClone = { ...cur.props, ref: 0 };
                const prevClone = { ...prev.props, ref: 0 };
                if (JSON.stringify(curClone) !== JSON.stringify(prevClone)) {
                    changed.push(cur.ref);
                }
            }
        }

        // Find removed (fingerprints in previous but not current)
        for (const [fp, prev] of _previousPageMapFingerprints) {
            if (!currentFingerprints.has(fp)) {
                removed.push(prev.ref);
            }
        }

        deltaResult = { added, removed, changed };

        // Store current state for next delta call
        _previousPageMapFingerprints = currentFingerprints;
        _previousPageMapMaxRef = Math.max(refCounter - 1, ...elements.map(e => e.ref));
    } else {
        // Non-delta call: reset tracking state (clean slate)
        _previousPageMapFingerprints = new Map();
        _previousPageMapMaxRef = 0;
    }

    // Build compressed content string
    let content = '';
    if (includeContent) {
        content = contentParts.join(' ').replace(/\s+/g, ' ').trim();
        // Cap content to avoid huge payloads
        if (content.length > 5000) {
            content = content.substring(0, 4997) + '...';
        }
    }

    const result: PageMapResult = {
        url: window.location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        elements,
        content,
    };

    // Add optional metadata
    if (scopeSelector) result.scope = scopeSelector;
    if (typeof options?.maxDepth === 'number') result.maxDepth = options.maxDepth;
    if (deltaResult) result.delta = deltaResult;

    console.log(`TAURI-PLUGIN-MCP: Page map generated: ${elements.length} interactive elements, ${content.length} chars content`);
    return result;
}

// Export the ref map lookup for use by other handlers
function getElementByRef(ref: number): Element | null {
    return _pageMapRefElements.get(ref) || null;
}

async function handleLocalStorageRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received get-local-storage, payload:', event.payload);
    
    try {
        const { action, key, value } = event.payload;
        
        // Convert values that might be JSON strings to their actual values
        let processedKey = key;
        let processedValue = value;
        
        // If key is a JSON string, try to parse it
        if (typeof key === 'string') {
            try {
                if (key.trim().startsWith('{') || key.trim().startsWith('[')) {
                    processedKey = JSON.parse(key);
                }
            } catch (e) {
                // Keep original if parsing fails
                console.log('TAURI-PLUGIN-MCP: Key not valid JSON, using as string');
            }
        }
        
        // If value is a JSON string, try to parse it
        if (typeof value === 'string') {
            try {
                if (value.trim().startsWith('{') || value.trim().startsWith('[')) {
                    processedValue = JSON.parse(value);
                }
            } catch (e) {
                // Keep original if parsing fails
                console.log('TAURI-PLUGIN-MCP: Value not valid JSON, using as string');
            }
        }
        
        console.log('TAURI-PLUGIN-MCP: Processing localStorage operation', { 
            action, 
            processedKey, 
            processedValue 
        });
        
        const result = performLocalStorageOperation(action, processedKey, processedValue);
        await emit('get-local-storage-response', result);
        console.log('TAURI-PLUGIN-MCP: Emitted get-local-storage-response');
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling localStorage request', error);
        await emit('get-local-storage-response', { 
            success: false, 
            error: error instanceof Error ? error.toString() : String(error) 
        }).catch(e => 
            console.error('TAURI-PLUGIN-MCP: Error emitting error response', e)
        );
    }
}

function performLocalStorageOperation(action: string, key?: string | any, value?: string | any): any {
    console.log('TAURI-PLUGIN-MCP: LocalStorage operation', { 
        action, 
        key: typeof key === 'undefined' ? 'undefined' : key, 
        value: typeof value === 'undefined' ? 'undefined' : value,
        keyType: typeof key,
        valueType: typeof value 
    });
    
    switch(action) {
        case 'get':
            if (!key) {
                console.log('TAURI-PLUGIN-MCP: Getting all localStorage items');
                // If no key is provided, return all localStorage items
                const allItems: Record<string, string> = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k) {
                        allItems[k] = localStorage.getItem(k) || '';
                    }
                }
                return {
                    success: true,
                    data: allItems
                };
            }
            console.log(`TAURI-PLUGIN-MCP: Getting localStorage item with key: ${key}`);
            return {
                success: true,
                data: localStorage.getItem(String(key))
            };
        case 'set':
            if (!key) {
                console.log('TAURI-PLUGIN-MCP: Set operation failed - no key provided');
                throw new Error('Key is required for set operation');
            }
            if (value === undefined) {
                console.log('TAURI-PLUGIN-MCP: Set operation failed - no value provided');
                throw new Error('Value is required for set operation');
            }
            
            const keyStr = String(key);
            const valueStr = String(value);
            console.log(`TAURI-PLUGIN-MCP: Setting localStorage item: ${keyStr} = ${valueStr}`);
            
            localStorage.setItem(keyStr, valueStr);
            return { success: true };
        case 'remove':
            if (!key) {
                console.log('TAURI-PLUGIN-MCP: Remove operation failed - no key provided');
                throw new Error('Key is required for remove operation');
            }
            console.log(`TAURI-PLUGIN-MCP: Removing localStorage item with key: ${key}`);
            localStorage.removeItem(String(key));
            return { success: true };
        case 'clear':
            console.log('TAURI-PLUGIN-MCP: Clearing all localStorage items');
            localStorage.clear();
            return { success: true };
        case 'keys':
            console.log('TAURI-PLUGIN-MCP: Getting all localStorage keys');
            return {
                success: true,
                data: Object.keys(localStorage)
            };
        default:
            console.log(`TAURI-PLUGIN-MCP: Unsupported localStorage action: ${action}`);
            throw new Error(`Unsupported localStorage action: ${action}`);
    }
}

// Handle JS execution requests
async function handleJsExecutionRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received execute-js, payload:', event.payload);
    
    try {
        // Extract the code to execute
        const code = event.payload;
        
        // Execute the code
        const result = executeJavaScript(code);
        
        // Prepare response with result and type information
        const response = {
            result: typeof result === 'object' ? JSON.stringify(result) : String(result),
            type: typeof result
        };
        
        // Send back the result
        await emit('execute-js-response', response);
        console.log('TAURI-PLUGIN-MCP: Emitted execute-js-response');
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error executing JavaScript:', error);
        const errorMessage = error instanceof Error ? error.toString() : String(error);
        
        await emit('execute-js-response', {
            result: null,
            type: 'error',
            error: errorMessage
        }).catch(e => 
            console.error('TAURI-PLUGIN-MCP: Error emitting error response', e)
        );
    }
}

// Function to safely execute JavaScript code
function executeJavaScript(code: string): any {
    // Using Function constructor is slightly safer than eval
    // It runs in global scope rather than local scope
    try {
        // For expressions, return the result
        return new Function(`return (${code})`)();
    } catch {
        // If that fails, try executing as statements
        return new Function(code)();
    }
}

async function handleSendTextToElementRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received send-text-to-element, payload:', event.payload);

    try {
        const { selectorType, selectorValue, text, delayMs = 20 } = event.payload;

        // Find the element based on the selector type
        let element = null;
        let debugInfo = [];

        switch (selectorType) {
            case 'ref':
                // Look up by numbered reference from get_page_map
                const refNum = parseInt(selectorValue, 10);
                element = getElementByRef(refNum);
                if (!element) {
                    debugInfo.push(`No element found with ref=${refNum}. Call get_page_map first to populate refs.`);
                }
                break;
            case 'id':
                element = document.getElementById(selectorValue);
                if (!element) {
                    debugInfo.push(`No element found with id="${selectorValue}"`);
                }
                break;
            case 'class':
                // Get the first element with the class
                const elemsByClass = document.getElementsByClassName(selectorValue);
                element = elemsByClass.length > 0 ? elemsByClass[0] : null;
                if (!element) {
                    debugInfo.push(`No elements found with class="${selectorValue}" (total matching: 0)`);
                } else if (elemsByClass.length > 1) {
                    debugInfo.push(`Found ${elemsByClass.length} elements with class="${selectorValue}", using the first one`);
                }
                break;
            case 'tag':
                // Get the first element with the tag name
                const elemsByTag = document.getElementsByTagName(selectorValue);
                element = elemsByTag.length > 0 ? elemsByTag[0] : null;
                if (!element) {
                    debugInfo.push(`No elements found with tag="${selectorValue}" (total matching: 0)`);
                } else if (elemsByTag.length > 1) {
                    debugInfo.push(`Found ${elemsByTag.length} elements with tag="${selectorValue}", using the first one`);
                }
                break;
            case 'text':
                // Find element by text content
                element = findElementByText(selectorValue);
                if (!element) {
                    debugInfo.push(`No element found with text="${selectorValue}"`);
                }
                break;
            default:
                throw new Error(`Unsupported selector type: ${selectorType}`);
        }
        
        if (!element) {
            throw new Error(`Element with ${selectorType}="${selectorValue}" not found. ${debugInfo.join(' ')}`);
        }
        
        // Check if the element is an input field, textarea, or has contentEditable
        const isEditableElement = 
            element instanceof HTMLInputElement || 
            element instanceof HTMLTextAreaElement || 
            element.isContentEditable;
            
        if (!isEditableElement) {
            console.warn(`Element is not normally editable: ${element.tagName}. Will try to set value/textContent directly.`);
        }
        
        // Focus the element first
        element.focus();
        
        // Set the text content based on element type
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            await simulateReactInputTyping(element, text, delayMs);
        } else if (element.isContentEditable) {
            // For contentEditable elements 
            console.log(`TAURI-PLUGIN-MCP: Setting text in contentEditable element: ${element.id || element.className}`);
            
            // Check if it's a specific type of editor
            const isLexicalEditor = element.hasAttribute('data-lexical-editor');
            const isSlateEditor = element.querySelector('[data-slate-editor="true"]') !== null;
            
            if (isLexicalEditor) {
                console.log('TAURI-PLUGIN-MCP: Detected Lexical editor, using specialized handling');
                await typeIntoLexicalEditor(element, text, delayMs);
            } else if (isSlateEditor) {
                console.log('TAURI-PLUGIN-MCP: Detected Slate editor, using specialized handling');
                await typeIntoSlateEditor(element, text, delayMs);
            } else {
                // Generic contentEditable handling
                await typeIntoContentEditable(element, text, delayMs);
            }
        } else {
            // For other elements, try to set textContent (may not work as expected)
            element.textContent = text;
            console.warn('TAURI-PLUGIN-MCP: Element is not an input, textarea, or contentEditable. Text was set directly but may not behave as expected.');
        }
        
        await emit('send-text-to-element-response', {
            success: true,
            data: {
                element: {
                    tag: element.tagName,
                    classes: element.className,
                    id: element.id,
                    type: element instanceof HTMLInputElement ? element.type : null,
                    text: text,
                    isEditable: isEditableElement
                }
            }
        });
    } catch (error) {
        console.error('TAURI-PLUGIN-MCP: Error handling send-text-to-element request', error);
        await emit('send-text-to-element-response', {
            success: false,
            error: error instanceof Error ? error.toString() : String(error)
        }).catch(e => console.error('TAURI-PLUGIN-MCP: Error emitting error response', e));
    }
}

// Better function to handle typing in React controlled components
async function simulateReactInputTyping(element: HTMLInputElement | HTMLTextAreaElement, text: string, delayMs: number): Promise<void> {
    console.log('TAURI-PLUGIN-MCP: Simulating typing on React component');
    
    // First focus the element - important for React to recognize the field
    element.focus();
    await new Promise(resolve => setTimeout(resolve, 50)); // Brief delay after focus
    
    // Instead of setting the value directly, we'll simulate keypresses
    // This approach more closely mimics real user interaction
    try {
        // For React, clear first by setting empty value and triggering events
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        
        // Wait a brief moment to let React's state update
        await new Promise(resolve => setTimeout(resolve, 50));
        
        console.log('TAURI-PLUGIN-MCP: Simulating keypress events for text:', text);
        
        // Simulate pressing each key with events in the correct sequence
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const partialText = text.substring(0, i + 1);
            
            // Simulate keydown
            const keydownEvent = new KeyboardEvent('keydown', {
                key: char,
                code: `Key${char.toUpperCase()}`,
                bubbles: true,
                cancelable: true,
                composed: true
            });
            element.dispatchEvent(keydownEvent);
            
            // Update value to what it would be after this keypress
            element.value = partialText;
            
            // Simulate input event (most important for React)
            const inputEvent = new Event('input', {
                bubbles: true,
                cancelable: true
            });
            element.dispatchEvent(inputEvent);
            
            // Simulate keyup
            const keyupEvent = new KeyboardEvent('keyup', {
                key: char,
                code: `Key${char.toUpperCase()}`,
                bubbles: true,
                cancelable: true,
                composed: true
            });
            element.dispatchEvent(keyupEvent);
            
            // Add delay between characters to simulate typing
            if (delayMs > 0 && i < text.length - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        
        // Final change event after all typing is complete
        const changeEvent = new Event('change', {
            bubbles: true,
            cancelable: true
        });
        element.dispatchEvent(changeEvent);
        
        // Give React a moment to process the final change
        await new Promise(resolve => setTimeout(resolve, 50));
        
        console.log('TAURI-PLUGIN-MCP: Completed React input typing simulation');
    } catch (e) {
        console.error('TAURI-PLUGIN-MCP: Error during React input typing:', e);
        
        // Last resort fallback - direct mutation
        console.log('TAURI-PLUGIN-MCP: Falling back to direct value assignment');
        element.value = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    // Ensure the value is set at the end regardless of method
    if (element.value !== text) {
        console.log('TAURI-PLUGIN-MCP: Final value check - correcting if needed');
        element.value = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

// Helper function to type text into a contentEditable element with a delay
async function typeIntoContentEditable(element: HTMLElement, text: string, delayMs: number): Promise<void> {
    console.log('TAURI-PLUGIN-MCP: Using general contentEditable typing approach');
    
    try {
        // Focus first
        element.focus();
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Clear existing content
        element.innerHTML = '';
        // Dispatch input event to notify frameworks of the change
        element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // For regular contentEditable, character-by-character simulation works well
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            
            // Simulate keydown
            const keydownEvent = new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: char,
                code: `Key${char.toUpperCase()}`
            });
            element.dispatchEvent(keydownEvent);
            
            // Insert the character by simulating typing
            // Use DOM selection and insertNode for proper insertion at cursor
            const selection = window.getSelection();
            const range = document.createRange();
            
            // Set range to end of element
            range.selectNodeContents(element);
            range.collapse(false); // Collapse to the end
            
            // Apply the selection
            selection?.removeAllRanges();
            selection?.addRange(range);
            
            // Insert text at cursor position
            const textNode = document.createTextNode(char);
            range.insertNode(textNode);
            
            // Move selection to after inserted text
            range.setStartAfter(textNode);
            range.setEndAfter(textNode);
            selection?.removeAllRanges();
            selection?.addRange(range);
            
            // Dispatch input event to notify of change
            element.dispatchEvent(new InputEvent('input', { 
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: char
            }));
            
            // Simulate keyup
            const keyupEvent = new KeyboardEvent('keyup', {
                bubbles: true,
                cancelable: true,
                key: char,
                code: `Key${char.toUpperCase()}`
            });
            element.dispatchEvent(keyupEvent);
            
            // Add delay between keypresses
            if (delayMs > 0 && i < text.length - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        
        // Final change event
        element.dispatchEvent(new Event('change', { bubbles: true }));
        
        console.log('TAURI-PLUGIN-MCP: Completed contentEditable text entry');
    } catch (e) {
        console.error('TAURI-PLUGIN-MCP: Error in contentEditable typing:', e);
        
        // Fallback: direct setting
        element.textContent = text;
        element.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
}

// Helper function specifically for Lexical Editor
async function typeIntoLexicalEditor(element: HTMLElement, text: string, delayMs: number): Promise<void> {
    console.log('TAURI-PLUGIN-MCP: Starting specialized Lexical editor typing');
    
    try {
        // First focus the element
        element.focus();
        await new Promise(resolve => setTimeout(resolve, 100)); // Longer focus delay for Lexical
        
        // Clear the editor - find any paragraph elements and clear them
        const paragraphs = element.querySelectorAll('p');
        if (paragraphs.length > 0) {
            for (const p of paragraphs) {
                p.innerHTML = '<br>'; // Lexical often uses <br> for empty paragraphs
            }
        } else {
            // If no paragraphs, try clearing directly (less reliable)
            element.innerHTML = '<p class="editor-paragraph"><br></p>';
        }
        
        // Trigger input event to notify Lexical of the change
        element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Find the first paragraph to type into
        const targetParagraph = element.querySelector('p') || element;
        
        // For Lexical, we'll also use the beforeinput event which it may listen for
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            
            // Find active element in case Lexical changed it
            const activeElement = document.activeElement;
            const currentTarget = (activeElement && element.contains(activeElement)) 
                ? activeElement 
                : targetParagraph;
            
            // Dispatch beforeinput event (important for Lexical)
            const beforeInputEvent = new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: char
            });
            currentTarget.dispatchEvent(beforeInputEvent);
            
            // Create and dispatch keydown
            const keydownEvent = new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: char,
                code: `Key${char.toUpperCase()}`,
                composed: true
            });
            currentTarget.dispatchEvent(keydownEvent);
            
            // Use execCommand for more reliable text insertion
            if (!beforeInputEvent.defaultPrevented) {
                document.execCommand('insertText', false, char);
            }
            
            // Dispatch input event
            const inputEvent = new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: char
            });
            currentTarget.dispatchEvent(inputEvent);
            
            // Create and dispatch keyup
            const keyupEvent = new KeyboardEvent('keyup', {
                bubbles: true,
                cancelable: true,
                key: char,
                code: `Key${char.toUpperCase()}`,
                composed: true
            });
            currentTarget.dispatchEvent(keyupEvent);
            
            // Add delay between keypresses
            if (delayMs > 0 && i < text.length - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        
        // Final selection adjustment (move to end of text)
        try {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(targetParagraph);
            range.collapse(false); // Collapse to end
            selection?.removeAllRanges();
            selection?.addRange(range);
        } catch (e) {
            console.warn('TAURI-PLUGIN-MCP: Error setting final selection:', e);
        }
        
        console.log('TAURI-PLUGIN-MCP: Completed Lexical editor typing');
    } catch (e) {
        console.error('TAURI-PLUGIN-MCP: Error in Lexical editor typing:', e);
        
        // Last resort fallback - try to set content directly
        try {
            const firstParagraph = element.querySelector('p') || element;
            firstParagraph.textContent = text;
            element.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } catch (innerError) {
            console.error('TAURI-PLUGIN-MCP: Fallback for Lexical editor failed:', innerError);
        }
    }
}

// Helper function specifically for Slate Editor
async function typeIntoSlateEditor(element: HTMLElement, text: string, delayMs: number): Promise<void> {
    console.log('TAURI-PLUGIN-MCP: Starting specialized Slate editor typing');
    
    try {
        // Focus the element
        element.focus();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Find the actual editable div in Slate editor
        const editableDiv = element.querySelector('[contenteditable="true"]') || element;
        if (editableDiv instanceof HTMLElement) {
            editableDiv.focus();
        }
        
        // For Slate, we'll try the execCommand approach which is often more reliable
        document.execCommand('selectAll', false, undefined);
        document.execCommand('delete', false, undefined);
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Simulate typing with proper events
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            
            // Ensure we're targeting the active element (Slate may change focus)
            const activeElement = document.activeElement || editableDiv;
            
            // Key events sequence
            activeElement.dispatchEvent(new KeyboardEvent('keydown', {
                key: char,
                bubbles: true,
                cancelable: true
            }));
            
            // Use execCommand for insertion
            document.execCommand('insertText', false, char);
            
            activeElement.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: char
            }));
            
            activeElement.dispatchEvent(new KeyboardEvent('keyup', {
                key: char,
                bubbles: true,
                cancelable: true
            }));
            
            // Delay between characters
            if (delayMs > 0 && i < text.length - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        
        console.log('TAURI-PLUGIN-MCP: Completed Slate editor typing');
    } catch (e) {
        console.error('TAURI-PLUGIN-MCP: Error in Slate editor typing:', e);
        
        // Fallback approach
        try {
            const editableDiv = element.querySelector('[contenteditable="true"]') || element;
            editableDiv.textContent = text;
            editableDiv.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } catch (innerError) {
            console.error('TAURI-PLUGIN-MCP: Fallback for Slate editor failed:', innerError);
        }
    }
}

// --- get_page_state handler ---
async function handleGetPageStateRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received get-page-state');
    try {
        await emit('get-page-state-response', JSON.stringify({
            success: true,
            data: {
                url: window.location.href,
                title: document.title,
                readyState: document.readyState,
                scrollPosition: { x: window.scrollX, y: window.scrollY },
                viewport: { width: window.innerWidth, height: window.innerHeight }
            }
        }));
    } catch (error) {
        await emit('get-page-state-response', JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}

// --- navigate_back handler ---
async function handleNavigateBackRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received navigate-back, payload:', event.payload);
    try {
        const { direction, delta } = event.payload || {};

        if (typeof delta === 'number') {
            history.go(delta);
        } else if (direction === 'forward') {
            history.forward();
        } else {
            history.back();
        }

        // Wait briefly for navigation to take effect
        await new Promise(resolve => setTimeout(resolve, 500));

        await emit('navigate-back-response', JSON.stringify({
            success: true,
            data: {
                url: window.location.href,
                title: document.title
            }
        }));
    } catch (error) {
        await emit('navigate-back-response', JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}

// --- scroll_page handler ---
async function handleScrollPageRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received scroll-page, payload:', event.payload);
    try {
        const { direction, amount, toRef, toTop, toBottom } = event.payload || {};

        if (toTop) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (toBottom) {
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
        } else if (typeof toRef === 'number') {
            const el = getElementByRef(toRef);
            if (!el) {
                throw new Error(`No element found with ref=${toRef}. Call get_page_map first.`);
            }
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            const vh = window.innerHeight;
            let pixels: number;
            if (typeof amount === 'number') {
                pixels = amount;
            } else if (amount === 'half') {
                pixels = Math.round(vh / 2);
            } else {
                // default: "page"
                pixels = vh;
            }
            if (direction === 'up') {
                pixels = -pixels;
            }
            window.scrollBy({ top: pixels, behavior: 'smooth' });
        }

        // Wait for smooth scroll to settle
        await new Promise(resolve => setTimeout(resolve, 350));

        await emit('scroll-page-response', JSON.stringify({
            success: true,
            data: {
                scrollPosition: { x: window.scrollX, y: window.scrollY },
                pageHeight: document.documentElement.scrollHeight,
                viewport: { width: window.innerWidth, height: window.innerHeight }
            }
        }));
    } catch (error) {
        await emit('scroll-page-response', JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}

// --- fill_form handler ---

// Helper to resolve an element from a field entry (by ref or selector)
function resolveElement(field: { ref?: number; selectorType?: string; selectorValue?: string }): Element | null {
    if (typeof field.ref === 'number') {
        return getElementByRef(field.ref);
    }
    if (field.selectorType && field.selectorValue) {
        switch (field.selectorType) {
            case 'id': return document.getElementById(field.selectorValue);
            case 'class': return document.getElementsByClassName(field.selectorValue)[0] || null;
            case 'css': return document.querySelector(field.selectorValue);
            case 'tag': return document.getElementsByTagName(field.selectorValue)[0] || null;
            case 'text': return findElementByText(field.selectorValue);
            default: return null;
        }
    }
    return null;
}

async function handleFillFormRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received fill-form, payload:', event.payload);
    try {
        const { fields, submitRef } = event.payload || {};

        if (!Array.isArray(fields) || fields.length === 0) {
            throw new Error('fields array is required and must not be empty');
        }

        const results: Array<{ ref?: number; success: boolean; error?: string }> = [];

        for (const field of fields) {
            const entry: { ref?: number; success: boolean; error?: string } = { ref: field.ref, success: false };
            try {
                const el = resolveElement(field);
                if (!el) {
                    entry.error = `Element not found (ref=${field.ref}, selector=${field.selectorType}:${field.selectorValue})`;
                    results.push(entry);
                    continue;
                }

                const clear = field.clear !== false; // default true

                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                    el.focus();
                    if (clear) {
                        el.value = '';
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    // Use the existing simulateReactInputTyping for proper React compat
                    await simulateReactInputTyping(el, field.value, 0);
                } else if (el instanceof HTMLSelectElement) {
                    el.focus();
                    el.value = field.value;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (el instanceof HTMLElement && el.isContentEditable) {
                    el.focus();
                    if (clear) {
                        el.innerHTML = '';
                        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
                    }
                    await typeIntoContentEditable(el, field.value, 0);
                } else {
                    entry.error = `Element <${el.tagName}> is not a form field`;
                    results.push(entry);
                    continue;
                }

                entry.success = true;
            } catch (fieldError) {
                entry.error = fieldError instanceof Error ? fieldError.message : String(fieldError);
            }
            results.push(entry);
        }

        // Optionally click submit button
        let submitResult = null;
        if (typeof submitRef === 'number') {
            const submitEl = getElementByRef(submitRef);
            if (submitEl && submitEl instanceof HTMLElement) {
                submitEl.click();
                submitResult = { clicked: true, tag: submitEl.tagName };
            } else {
                submitResult = { clicked: false, error: `Submit element ref=${submitRef} not found` };
            }
        }

        await emit('fill-form-response', JSON.stringify({
            success: true,
            data: { fields: results, submit: submitResult }
        }));
    } catch (error) {
        await emit('fill-form-response', JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}

// --- wait_for handler ---
async function handleWaitForRequest(event: any) {
    console.log('TAURI-PLUGIN-MCP: Received wait-for, payload:', event.payload);
    try {
        const { text, selector, ref: refNum, state = 'visible', timeoutMs = 10000 } = event.payload || {};
        const pollInterval = 200;

        const result = await new Promise<{ found: boolean; elapsed: number }>((resolve) => {
            const startTime = Date.now();
            let observer: MutationObserver | null = null;

            function checkCondition(): boolean {
                if (typeof text === 'string') {
                    const bodyText = document.body?.innerText || '';
                    const found = bodyText.includes(text);
                    return state === 'hidden' ? !found : found;
                }

                let el: Element | null = null;
                if (typeof refNum === 'number') {
                    el = getElementByRef(refNum);
                } else if (typeof selector === 'string') {
                    el = document.querySelector(selector);
                }

                switch (state) {
                    case 'attached':
                        return el !== null;
                    case 'detached':
                        return el === null;
                    case 'hidden':
                        if (!el) return true;
                        return !isElementVisible(el);
                    case 'visible':
                    default:
                        if (!el) return false;
                        return isElementVisible(el);
                }
            }

            function finish(found: boolean) {
                if (observer) observer.disconnect();
                resolve({ found, elapsed: Date.now() - startTime });
            }

            // Check immediately
            if (checkCondition()) {
                finish(true);
                return;
            }

            // Set up polling + MutationObserver
            const interval = setInterval(() => {
                if (checkCondition()) {
                    clearInterval(interval);
                    finish(true);
                    return;
                }
                if (Date.now() - startTime >= timeoutMs) {
                    clearInterval(interval);
                    finish(false);
                }
            }, pollInterval);

            observer = new MutationObserver(() => {
                if (checkCondition()) {
                    clearInterval(interval);
                    finish(true);
                }
            });

            observer.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            });

            // Hard timeout
            setTimeout(() => {
                clearInterval(interval);
                finish(checkCondition());
            }, timeoutMs);
        });

        await emit('wait-for-response', JSON.stringify({
            success: true,
            data: {
                found: result.found,
                elapsed: result.elapsed,
                timedOut: !result.found
            }
        }));
    } catch (error) {
        await emit('wait-for-response', JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        }));
    }
}