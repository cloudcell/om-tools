// Optional site chrome; no engine access or external scripts.
const questions = [
    ['useful', 'Was the demonstration useful?', ['Yes', 'Somewhat', 'No']],
    ['clarity', 'How clear was the modeling approach?', ['Clear', 'Partly clear', 'Unclear']],
    ['relevance', 'Could you use this in your work?', ['Yes', 'Maybe', 'No']]
];
const endpoint = 'https://docs.google.com/forms/d/e/1FAIpQLSdyGqheXvFGHzZ3byfxMiufr29QQqSkQTcIv5vMzc95KSnabw/formResponse';
const entries = {source:'1561937932', build_commit:'989069230', tour_step:'232281322', tour_outcome:'660712315', useful:'1014796442', clarity:'1300314149', relevance:'328191154', comment:'974561779', email:'955764004'};
let active: HTMLDialogElement | null = null;
let maxStep = 0;
declare const OM_FEEDBACK_COMMIT: string;
const buildCommit = typeof OM_FEEDBACK_COMMIT !== 'undefined' ? OM_FEEDBACK_COMMIT : 'unavailable';
function showFeedback(event: {detail: {outcome: string; step: number}}) {
    if (active) return;
    const dialog = document.createElement('dialog');
    active = dialog;
    dialog.className = 'om-vscode-feedback';
    Object.assign(dialog.style, {background:'var(--vscode-editor-background)', color:'var(--vscode-editor-foreground)', border:'1px solid var(--vscode-panel-border)', borderRadius:'8px', padding:'20px', width:'min(480px, 85vw)', maxHeight:'85vh', overflow:'auto'});
    const form = document.createElement('form');
    const title = document.createElement('h1');
    title.textContent = 'Help improve Open Modeling';
    form.append(title);
    const outcome = document.createElement('input');
    outcome.type = 'hidden'; outcome.name = 'tour_outcome'; outcome.value = event?.detail?.outcome || 'completed';
    form.append(outcome);
    for (const [key, label, choices] of questions) {
        const field = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = label;
        field.append(legend);
        field.style.marginBottom = '12px';
        for (const choice of choices) {
            const l = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'radio'; input.name = key; input.value = choice.toLowerCase();
            l.append(input, document.createTextNode(choice + ' '));
            field.append(l);
        }
        form.append(field);
    }
    for (const [key, label, type] of [['comment', 'What was unclear or missing? (optional)', 'textarea'], ['email', 'Email for product follow-up (optional)', 'email']]) {
        const l = document.createElement('label');
        l.textContent = label;
        const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
        if (type !== 'textarea') (input as HTMLInputElement).type = type;
        input.name = key; input.maxLength = key === 'email' ? 254 : 2000;
        input.style.display = 'block'; input.style.width = '100%';
        l.append(input); form.append(l);
    }
    const note = document.createElement('p');
    note.textContent = 'Optional feedback is sent to Google Forms. Do not include confidential model data. Providing email permits product feedback follow-up.';
    const actions = document.createElement('div');
    actions.className = 'welcome-actions';
    const skip = document.createElement('button');
    skip.type = 'button'; skip.className = 'welcome-close'; skip.textContent = 'Skip';
    skip.onclick = () => dialog.close();
    const send = document.createElement('button');
    send.className = 'welcome-start'; send.textContent = 'Send feedback';
    Object.assign(actions.style,{display:'flex',justifyContent:'flex-end',gap:'8px',marginTop:'12px'});
    actions.append(skip, send); form.append(note, actions);
    dialog.append(form); document.body.append(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); active = null; });
    form.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(Array.from(new FormData(form), ([k,v]) => [k,String(v)])) as Record<string,string>;
        if (!Object.entries(data).some(([k,v]) => k !== 'tour_outcome' && v.trim())) { note.textContent = 'Please answer at least one question, or skip.'; return; }
        if (send.disabled) return;
        data.source = 'vscode';
        send.disabled = true;
        data.build_commit = buildCommit;
        data.tour_step = String(event?.detail?.step || '');
        const body = new URLSearchParams();
        for (const [key, id] of Object.entries(entries)) {
            const value = data[key]?.trim();
            if (value) body.set('entry.' + id, value);
        }
        send.disabled = true;
        skip.disabled = true;
        note.textContent = 'Sending feedback…';
        try {
            await fetch(endpoint, {method:'POST', mode:'no-cors', credentials:'omit', body, referrerPolicy:'no-referrer'});
            note.textContent = 'Thank you. Feedback sent; receipt cannot be verified here.';
            skip.textContent = 'Close';
        } catch {
            note.textContent = 'Could not send feedback. Please try again.';
            send.disabled = false;
        } finally {
            skip.disabled = false;
        }
    });
    dialog.showModal();
}
export function installFeedback() {
    
    // Bridge the pinned GUI's existing tour controls without modifying vendor artifacts.
    // Capture before the GUI removes its callout; verify teardown after dispatch.
    function recordStep(tour: Element) {
        const n = Number(tour.querySelector('.om-tour-count')?.textContent?.split('/')[0].trim());
        if (Number.isInteger(n) && n > 0) maxStep = Math.max(maxStep, n);
    }
    function afterTour(tour: Element, outcome: string) {
        recordStep(tour);
        const step = maxStep;
        // A native click can run microtasks between capture and target listeners.
        // Wait for the entire event dispatch before checking GUI teardown.
        setTimeout(() => {
            if (!tour.isConnected && !document.querySelector('.om-tour')) {
                showFeedback({ detail: { outcome, step } });
                maxStep = 0;
            }
        }, 0);
    }
    document.addEventListener('click', e => {
        const button = e.target instanceof Element && e.target.closest('button');
        const tour = button && button.closest('.om-tour');
        if (!tour || !button) return;
        recordStep(tour);
        if (button.matches('.om-tour-skip')) afterTour(tour, 'skipped');
        else if (button.matches('.om-tip-btn.primary') && button.textContent?.trim() === 'Done') afterTour(tour, 'completed');
    }, true);
    document.addEventListener('keydown', e => {
        const tour = e.target instanceof Element && e.target.closest('.om-tour');
        if (!tour) return;
        recordStep(tour);
        if (e.key === 'Escape') afterTour(tour, 'cancelled');
        else if (e.key === 'ArrowRight' && tour.querySelector('.om-tip-btn.primary')?.textContent.trim() === 'Done') afterTour(tour, 'completed');
    }, true);
}
