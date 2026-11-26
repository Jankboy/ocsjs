import type { QuestionTypes } from '@ocsjs/core';

const completionContainer = '.fill-blank-reply, .question-material-banked-cloze-scoop';

function completionInputs(root: HTMLElement) {
	return Array.from(
		root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
			'input:not(:disabled):not([readonly]), .question-inputbox textarea:not(:disabled):not([readonly])'
		)
	).filter((input) => input.tagName === 'TEXTAREA' || input.closest(completionContainer));
}

export function unipusQuestionType(root: HTMLElement): QuestionTypes {
	const page = root.closest('.question-abs-question') || root;
	if (/based on your own experiences|true for you/i.test(page.textContent || '')) return undefined;
	const replies = Array.from(root.querySelectorAll<HTMLElement>('.reply-wrap > .question-common-abs-reply'));
	if (replies.length > 1 && replies.some((reply) => !unipusQuestionType(reply))) return undefined;
	const choice = root.matches('.question-common-abs-choice')
		? root
		: root.querySelector<HTMLElement>('.question-common-abs-choice');
	// 词汇测验的普通单选容器没有 singleChoice 标记。
	if (choice?.querySelector('.option.isNotReview')) {
		return choice.classList.contains('multipleChoice') ? 'multiple' : 'single';
	}
	if (completionInputs(root).length) return 'completion';
	return undefined;
}

export function unipusOptions(root: HTMLElement): HTMLElement[] {
	if (unipusQuestionType(root) === 'completion') {
		return completionInputs(root);
	}
	return Array.from(root.querySelectorAll<HTMLElement>('.question-common-abs-choice .option'));
}

/** 一个段落可以有多个空，但它们仍属于同一道有编号的小题。 */
export function unipusQuestions(root: HTMLElement): HTMLElement[] {
	const replies = Array.from(root.querySelectorAll<HTMLElement>('.reply-wrap > .question-common-abs-reply'));
	if (replies.length > 1 && replies.every((reply) => unipusQuestionType(reply))) return replies;
	if (unipusQuestionType(root) !== 'completion') return [root];
	const paragraphs = Array.from(
		root.querySelectorAll<HTMLElement>('.fill-blank-reply p, .question-material-banked-cloze-scoop p')
	).filter((paragraph) => /^\s*\d+[.)、]\s*/.test(paragraph.textContent || '') && unipusOptions(paragraph).length);
	const count = paragraphs.reduce((sum, paragraph) => sum + unipusOptions(paragraph).length, 0);
	return paragraphs.length > 1 && count === unipusOptions(root).length ? paragraphs : [root];
}

/** 编号用来标识小题，不能直接当作填空分隔符；英语词组中的空格必须保留。 */
export function normalizeUnipusCompletionAnswer(answer: string, blankCount: number, questionNumber?: number) {
	const markers = Array.from(answer.matchAll(/(?:^|\s)(\d{1,2})[.)、]\s+/g));
	let value = answer.trim();
	if (markers.length) {
		if (answer.slice(0, markers[0].index).trim()) return undefined;
		if (markers.some((marker, index) => index > 0 && Number(marker[1]) !== Number(markers[index - 1][1]) + 1)) {
			return undefined;
		}
		// 连续篇章保留为一道多空题，逐空编号的完整答案可按序回填。
		if (questionNumber === undefined && blankCount > 1 && markers.length === blankCount && markers[0][1] === '1') {
			const values = markers.map((marker, index) =>
				answer.slice(marker.index! + marker[0].length, markers[index + 1]?.index).trim()
			);
			return values.every(Boolean) ? JSON.stringify(values) : undefined;
		}
		const index = markers.length === 1 ? 0 : markers.findIndex((marker) => Number(marker[1]) === questionNumber);
		if (index < 0) return undefined;
		if (markers.length === 1 && Number(markers[0][1]) !== 1 && Number(markers[0][1]) !== questionNumber)
			return undefined;
		const marker = markers[index];
		value = answer.slice(marker.index! + marker[0].length, markers[index + 1]?.index).trim();
		if (!value) return undefined;
	}
	// 年份等纯数字答案可以按空位数量精确拆分，"two weeks" 等词组交给公共解析器。
	const numbers = value.split(/\s+/);
	if (blankCount > 1 && numbers.length === blankCount && numbers.every((part) => /^[-+]?\d+(?:\.\d+)?$/.test(part))) {
		return JSON.stringify(numbers);
	}
	return value;
}

/** 词汇释义有各自的音频按钮，只播放题目正文中的主音视频。 */
export function unipusMedia(root: HTMLElement | Document): HTMLMediaElement | null {
	return (
		Array.from(
			root.querySelectorAll<HTMLMediaElement>('.question-video-player video, .audio-material-wrapper audio')
		).find((media) => !media.closest('.word-audio, .qc-abs-word-tips')) || null
	);
}

/** React 受控输入框需要调用原生 setter，再派发 input 事件。 */
export function fillUnipusInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
	const win = input.ownerDocument.defaultView;
	if (!win) return;
	const prototype = input.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
	setter?.call(input, value);
	input.dispatchEvent(new win.Event('input', { bubbles: true }));
	input.dispatchEvent(new win.Event('change', { bubbles: true }));
}

export function unipusRequired(text: string): boolean | undefined {
	const value = text.match(/是否必修[：:]\s*(非必修|必修)/)?.[1];
	if (value === '必修') return true;
	if (value === '非必修') return false;
	return undefined;
}

export function unipusNext(doc: Document, nextMicro = false): HTMLElement | undefined {
	for (const [selector, activeClass] of nextMicro
		? []
		: [
				['.pc-header-tasks-row .pc-task', 'pc-header-task-activity'],
				['.pc-tab-row .tab', 'pc-header-tab-activity']
		  ]) {
		const tabs = Array.from(doc.querySelectorAll<HTMLElement>(selector));
		const index = tabs.findIndex((tab) => tab.classList.contains(activeClass));
		if (index >= 0 && index + 1 < tabs.length) return tabs[index + 1];
	}
	const micros = Array.from(doc.querySelectorAll<HTMLElement>('.pc-slider-menu-micro'));
	const index = micros.findIndex((micro) => micro.classList.contains('pc-menu-activity'));
	const next = index >= 0 ? micros[index + 1] : undefined;
	if (next?.getAttribute('aria-disabled') === 'true' || next?.querySelector('[aria-label="lock"]')) return undefined;
	return next;
}
