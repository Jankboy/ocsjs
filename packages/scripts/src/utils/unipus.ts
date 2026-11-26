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

export type UnipusJumpMode = 'next' | 'job' | 'manually';

function navigationLocked(element: HTMLElement) {
	return (
		element.matches(':disabled') ||
		element.hasAttribute('disabled') ||
		element.getAttribute('aria-disabled') === 'true' ||
		!!element.querySelector('[aria-label="lock"]')
	);
}

/** 全圆表示已完成，半圆表示尚未完成；没有进度标记时保留未知状态。 */
export function unipusMicroFinished(micro: HTMLElement): boolean | undefined {
	if (micro.querySelector('.pc-slider-menu-status-circle-all')) return true;
	if (micro.querySelector('.pc-slider-menu-status-circle-half')) return false;
	return undefined;
}

export function unipusNext(
	doc: Document,
	nextMicro = false,
	mode: UnipusJumpMode = 'next',
	excluded: ReadonlySet<HTMLElement> = new Set()
): HTMLElement | undefined {
	if (mode === 'manually') return undefined;
	const micros = Array.from(doc.querySelectorAll<HTMLElement>('.pc-slider-menu-micro'));
	const index = micros.findIndex((micro) => micro.classList.contains('pc-menu-activity'));
	// 目录进度不能代替当前板块各页签的状态，先走完练习和页签再选择目录任务。
	for (const [selector, activeClass] of nextMicro
		? []
		: [
				['.pc-header-tasks-row .pc-task', 'pc-header-task-activity'],
				['.pc-tab-row .tab', 'pc-header-tab-activity']
		  ]) {
		const tabs = Array.from(doc.querySelectorAll<HTMLElement>(selector));
		const index = tabs.findIndex((tab) => tab.classList.contains(activeClass));
		if (index >= 0 && index + 1 < tabs.length) {
			return navigationLocked(tabs[index + 1]) ? undefined : tabs[index + 1];
		}
	}
	// 板块内的练习和页签结束后，让平台的“继续学习”处理下一节及解锁条件。
	if (mode === 'next' && !nextMicro && unipusWorkSubmitted(doc)) {
		const button = Array.from(doc.querySelectorAll<HTMLElement>('#pc-foot button, #pc-foot a')).find(
			(element) =>
				element.textContent?.replace(/\s/g, '') === '继续学习' && !element.closest('[hidden], [aria-hidden="true"]')
		);
		if (button) return navigationLocked(button) ? undefined : button;
	}
	if (index < 0) return undefined;
	if (mode === 'job') {
		return [...micros.slice(index + 1), ...micros.slice(0, index)].find(
			(micro) => !excluded.has(micro) && !navigationLocked(micro) && unipusMicroFinished(micro) === false
		);
	}
	const next = micros[index + 1];
	if (next && navigationLocked(next)) return undefined;
	return next;
}

/** 提交后的操作按钮出现时才允许离开，确认弹窗和仍可提交的页面继续等待。 */
export function unipusWorkSubmitted(doc: Document) {
	if (doc.querySelector('.ant-modal-content')) return false;
	const content = doc.querySelector('#main-content');
	if (
		content &&
		!content.querySelector(
			'.option.isNotReview, input:not(:disabled):not([readonly]), textarea:not(:disabled):not([readonly])'
		)
	) {
		const labels = Array.from(content.querySelectorAll('h1, h2, h3, h4, div, span')).map((element) =>
			element.textContent?.trim()
		);
		if (labels.includes('答题小结') && labels.includes('答题情况')) return true;
	}
	const text = doc.querySelector('#pc-foot .question-common-course-page .btn')?.textContent?.replace(/\s/g, '');
	return /^(重新答题|重新作答|重做|再做一次|查看答案|查看解析|已提交)$/.test(text || '');
}
