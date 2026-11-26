import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	fillUnipusInput,
	normalizeUnipusCompletionAnswer,
	unipusMedia,
	unipusMicroFinished,
	unipusNext,
	unipusOptions,
	unipusQuestionType,
	unipusQuestions,
	unipusRequired,
	unipusWorkSubmitted
} from '../packages/scripts/src/utils/unipus';

require('browser-env')();

function page(html: string) {
	document.body.innerHTML = html;
	return document.body;
}

test('识别多选与选项，不把词汇表作为选项', () => {
	const root = page(`<div class="question-common-abs-choice multipleChoice">
		<div class="option isNotReview">A</div><div class="option selected isNotReview">B</div>
	</div><div class="word-item">Vocabulary</div>`);
	assert.equal(unipusQuestionType(root), 'multiple');
	assert.equal(unipusOptions(root).length, 2);
});

test('识别单选及填空，过滤禁用输入框', () => {
	assert.equal(
		unipusQuestionType(
			page('<div class="question-common-abs-choice singleChoice"><div class="option isNotReview"></div></div>')
		),
		'single'
	);
	const root = page('<div class="fill-blank-reply"><input><input disabled><input></div>');
	assert.equal(unipusQuestionType(root), 'completion');
	assert.equal(unipusOptions(root).length, 2);
	assert.equal(
		unipusQuestionType(page('<div class="fill-blank-reply"><input readonly><input disabled></div>')),
		undefined
	);
	assert.equal(
		unipusQuestionType(page('<div class="question-common-abs-choice multipleChoice"><div class="option"></div></div>')),
		undefined
	);
});

test('个人经历、讨论、拖拽等未适配题型交给用户', () => {
	assert.equal(
		unipusQuestionType(page('<div class="fill-blank-reply">Fill in based on your own experiences<input></div>')),
		undefined
	);
	assert.equal(
		unipusQuestionType(page('<div class="fill-blank-reply">Which are true for you?<input></div>')),
		undefined
	);
	assert.equal(unipusQuestionType(page('<div class="discussion"><textarea></textarea></div>')), undefined);
});

test('词汇测验没有 singleChoice 标记，同页十题分别提取选项', () => {
	const root = page(
		`<div class="question-abs-question"><div class="reply-wrap">${Array.from(
			{ length: 10 },
			(_, index) => `<div class="question-common-abs-reply"><div class="question-common-abs-choice">
		<div class="ques-title">${index + 1}. word ${index}</div><div class="option-wrap">
		<div class="option isNotReview"><div class="caption">A</div><div class="content">meaning ${index}</div></div>
		<div class="option isNotReview"><div class="caption">B</div><div class="content">other ${index}</div></div>
		</div></div></div>`
		).join('')}</div></div>`
	);
	assert.equal(unipusQuestionType(root), 'single');
	const questions = unipusQuestions(root);
	assert.equal(questions.length, 10);
	questions.forEach((question, index) => {
		assert.equal(unipusQuestionType(question), 'single');
		const options = unipusOptions(question);
		assert.equal(options.length, 2);
		assert.equal(options[0].querySelector('.content')?.textContent, `meaning ${index}`);
	});
});

test('同页选择题按各自题型解析，个人经历题不能被拆题绕过', () => {
	const root = page(`<div class="question-abs-question"><div class="reply-wrap">
		<div class="question-common-abs-reply"><div class="question-common-abs-choice"><div class="option isNotReview">A</div></div></div>
		<div class="question-common-abs-reply"><div class="question-common-abs-choice multipleChoice"><div class="option isNotReview">B</div></div></div>
	</div></div>`);
	assert.deepEqual(unipusQuestions(root).map(unipusQuestionType), ['single', 'multiple']);
	root.querySelector('.question-abs-question')!.prepend(document.createTextNode('Choose statements true for you.'));
	assert.equal(unipusQuestionType(root), undefined);
	assert.deepEqual(unipusQuestions(root), [root]);
});

test('四道填空小题拆为四个根节点，同一道题保留两个空', () => {
	const root =
		page(`<div class="question-abs-question"><div class="fill-blank-reply"><div class="item"><div class="component-htmlview">
		<p>1. Began in <span class="scoop-input-wrapper"><input></span>. Named in <span class="scoop-input-wrapper"><input></span>.</p>
		<p>2. In early <span class="scoop-input-wrapper"><input></span>.</p>
		<p>3. In about <span class="scoop-input-wrapper"><input></span>.</p>
		<p>4. Until <span class="scoop-input-wrapper"><input></span>.</p>
	</div></div></div></div>`).firstElementChild as HTMLElement;
	const questions = unipusQuestions(root);
	assert.equal(questions.length, 4);
	assert.deepEqual(
		questions.map((question) => unipusOptions(question).length),
		[2, 1, 1, 1]
	);
	assert.ok(questions.every((question) => unipusQuestionType(question) === 'completion'));
	assert.equal(questions.flatMap(unipusOptions).length, 5);
});

test('截图中的编号答案按小题回填，保留 two weeks 词组', () => {
	const { resolveCompletion } = require('../packages/core/src/core/worker/resolvers/completion');
	const answer = '1. 1963 1985 2. December 3. two weeks 4. March';
	const counts = [2, 1, 1, 1];
	const expected = [['1963', '1985'], ['December'], ['two weeks'], ['March']];
	counts.forEach((count, index) => {
		const normalized = normalizeUnipusCompletionAnswer(answer, count, index + 1);
		assert.deepEqual(resolveCompletion([[normalized]], count), { finish: true, answers: expected[index] });
	});
});

test('独立查询的小题可使用编号答案或原有分隔符，歧义时保持失败', () => {
	assert.equal(normalizeUnipusCompletionAnswer('1. 1963 1985', 2, 1), '["1963","1985"]');
	assert.equal(normalizeUnipusCompletionAnswer('2. December', 1, 2), 'December');
	assert.equal(normalizeUnipusCompletionAnswer('1963;1985', 2, 1), '1963;1985');
	assert.equal(normalizeUnipusCompletionAnswer('two weeks', 1, 3), 'two weeks');
	assert.equal(normalizeUnipusCompletionAnswer('two weeks March', 2, 1), 'two weeks March');
	assert.equal(normalizeUnipusCompletionAnswer('1. A 3. C', 1, 2), undefined);
	assert.equal(normalizeUnipusCompletionAnswer('1. A 2. B', 1, 3), undefined);
	assert.equal(normalizeUnipusCompletionAnswer('2. ', 1, 2), undefined);
	assert.equal(normalizeUnipusCompletionAnswer('3.14', 1, 1), '3.14');
});

test('未编号的连续段落不擅自拆题', () => {
	const root = page('<div class="fill-blank-reply"><p>First <input></p><p>Then <input></p></div>');
	assert.deepEqual(unipusQuestions(root), [root]);
});

test('可输入选词题拆分编号句子，过滤不可编辑空位', () => {
	const root = page(`<div class="question-abs-question"><div class="question-material-banked-cloze-reply">
		<div class="option-placeholder">available</div></div><div class="question-material-banked-cloze-scoop">
		<p>1. Space <span class="scoop-wrapper"><input></span>.</p>
		<p>2. Resources <span class="scoop-wrapper"><input></span>.</p>
		<p>Review <input readonly><input disabled></p></div><input id="unrelated"></div>`);
	assert.equal(unipusQuestionType(root), 'completion');
	assert.equal(unipusOptions(root).length, 2);
	assert.deepEqual(
		unipusQuestions(root).map((question) => unipusOptions(question).length),
		[1, 1]
	);
});

test('篇章选词保留上下文，完整逐空编号答案按空位顺序解析', () => {
	const root = page(`<div class="question-material-banked-cloze-scoop">
		<p>People <span class="scoop-wrapper"><input></span> learning <span class="scoop-wrapper"><input></span>.</p>
		<p>Then <span class="scoop-wrapper"><input></span>.</p></div>`);
	assert.deepEqual(unipusQuestions(root), [root]);
	assert.equal(unipusOptions(root).length, 3);
	assert.equal(
		normalizeUnipusCompletionAnswer('1. classify 2. passion 3. two words', 3),
		'["classify","passion","two words"]'
	);
	assert.equal(normalizeUnipusCompletionAnswer('1. classify 3. passion', 3), undefined);
	assert.equal(normalizeUnipusCompletionAnswer('1. classify 2. ', 2), undefined);
});

test('阅读简答框分别回填多行答案，保留正文中的编号', () => {
	const root = page(`<div class="question-abs-question"><div class="reply-wrap">
		<div class="question-common-abs-reply"><div class="question-inputbox"><div class="question-inputbox-header">1. Why?</div><textarea></textarea></div></div>
		<div class="question-common-abs-reply"><div class="question-inputbox"><div class="question-inputbox-header">2. How?</div><textarea></textarea></div></div>
	</div></div>`);
	assert.equal(unipusQuestionType(root), 'completion');
	const questions = unipusQuestions(root);
	assert.equal(questions.length, 2);
	const textarea = unipusOptions(questions[0])[0] as HTMLTextAreaElement;
	let updated = '';
	textarea.addEventListener('input', () => (updated = textarea.value));
	fillUnipusInput(textarea, '1. First reason.\n2. Second reason.');
	assert.equal(updated, '1. First reason.\n2. Second reason.');
	assert.equal((unipusOptions(questions[1])[0] as HTMLTextAreaElement).value, '');
});

test('不把讨论框和有未适配子题的页面当作完整练习', () => {
	assert.equal(unipusQuestionType(page('<textarea></textarea>')), undefined);
	assert.equal(
		unipusQuestionType(page('<div class="question-inputbox"><textarea readonly></textarea></div>')),
		undefined
	);
	const root = page(`<div class="reply-wrap">
		<div class="question-common-abs-reply"><div class="question-common-abs-choice"><div class="option isNotReview">A</div></div></div>
		<div class="question-common-abs-reply"><div class="unknown-reply"></div></div>
	</div>`);
	assert.equal(unipusQuestionType(root), undefined);
	assert.deepEqual(unipusQuestions(root), [root]);
});

test('选主媒体，排除词汇音频', () => {
	const root =
		page(`<div class="qc-abs-word-tips"><div class="audio-material-wrapper"><audio id="word"></audio></div></div>
		<div class="audio-material-wrapper"><audio id="main"></audio></div>`);
	assert.equal(unipusMedia(root)?.id, 'main');
	assert.equal(unipusMedia(page('<div class="word-audio"><audio></audio></div>')), null);
	assert.equal(unipusMedia(page('<div class="question-video-player"><video id="video"></video></div>'))?.id, 'video');
});

test('原生 setter 与 input 事件更新受控输入框', () => {
	const root = page('<input>');
	const input = root.querySelector('input')!;
	let valueOnInput = '';
	let changes = 0;
	Object.defineProperty(input, 'value', {
		get: () => 'old',
		set: () => assert.fail('不能使用 React 包装过的 setter'),
		configurable: true
	});
	input.addEventListener('input', () => {
		valueOnInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.get!.call(input);
	});
	input.addEventListener('change', () => changes++);
	fillUnipusInput(input, 'answer');
	assert.equal(valueOnInput, 'answer');
	assert.equal(changes, 1);
});

test('必修、非必修与未知状态分别处理', () => {
	assert.equal(unipusRequired('本单元学习时间：2026-09-07至2026-11-30 是否必修：必修'), true);
	assert.equal(unipusRequired('是否必修：非必修'), false);
	assert.equal(unipusRequired('是否必修:  必修'), true);
	assert.equal(unipusRequired('请查看学习要求'), undefined);
});

test('导航先切同组练习，然后切页签，最后切目录任务', () => {
	page(`<div class="pc-header-tasks-row"><div class="pc-task pc-header-task-activity"></div><div id="exercise" class="pc-task"></div></div>
		<div class="pc-tab-row"><div class="tab pc-header-tab-activity"></div><div id="tab" class="tab"></div></div>
		<div class="pc-slider-menu-micro pc-menu-activity"></div><div id="micro" class="pc-slider-menu-micro"></div>`);
	assert.equal(unipusNext(document)?.id, 'exercise');
	document.querySelector('#exercise')!.remove();
	assert.equal(unipusNext(document)?.id, 'tab');
	assert.equal(unipusNext(document, true)?.id, 'micro');
	document.querySelector('#tab')!.remove();
	assert.equal(unipusNext(document)?.id, 'micro');
});

test('没有当前任务或下一项锁定时停止', () => {
	page('<div class="pc-slider-menu-micro"></div>');
	assert.equal(unipusNext(document), undefined);
	page(
		'<div class="pc-slider-menu-micro pc-menu-activity"></div><div class="pc-slider-menu-micro" aria-disabled="true"></div>'
	);
	assert.equal(unipusNext(document), undefined);
	page(
		'<div class="pc-slider-menu-micro pc-menu-activity"></div><div class="pc-slider-menu-micro"><span aria-label="lock"></span></div>'
	);
	assert.equal(unipusNext(document), undefined);
});

test('手动跳转模式不会选择下一练习、页签或任务', () => {
	page(`<div class="pc-header-tasks-row"><div class="pc-task pc-header-task-activity"></div><div class="pc-task"></div></div>
		<div class="pc-slider-menu-micro pc-menu-activity"></div><div class="pc-slider-menu-micro"></div>`);
	assert.equal(unipusNext(document, false, 'manually'), undefined);
	assert.equal(unipusNext(document, true, 'manually'), undefined);
});

test('任务完成标记区分全部完成、部分完成和未知状态', () => {
	for (const [className, expected] of [
		['pc-slider-menu-status-circle-all', true],
		['pc-slider-menu-status-circle-half', false],
		['unknown', undefined]
	] as const) {
		assert.equal(unipusMicroFinished(page(`<div class="${className}"></div>`)), expected);
	}
});

test('未完成模式跳过已完成、锁定、未知及非必修任务，并可回到前面的未完成任务', () => {
	page(`<div id="earlier" class="pc-slider-menu-micro"><div class="pc-slider-menu-status-circle-half"></div></div>
		<div class="pc-slider-menu-micro pc-menu-activity"><div class="pc-slider-menu-status-circle-all"></div></div>
		<div class="pc-slider-menu-micro"><div class="pc-slider-menu-status-circle-all"></div></div>
		<div class="pc-slider-menu-micro" aria-disabled="true"><div class="pc-slider-menu-status-circle-half"></div></div>
		<div class="pc-slider-menu-micro"></div>
		<div id="optional" class="pc-slider-menu-micro"><div class="pc-slider-menu-status-circle-half"></div></div>
		<div id="later" class="pc-slider-menu-micro"><div class="pc-slider-menu-status-circle-half"></div></div>`);
	const excluded = new Set([document.querySelector<HTMLElement>('#optional')!]);
	assert.equal(unipusNext(document, false, 'job', excluded)?.id, 'later');
	document.querySelector('#later')!.remove();
	assert.equal(unipusNext(document, false, 'job', excluded)?.id, 'earlier');
	document.querySelector('#earlier')!.remove();
	assert.equal(unipusNext(document, false, 'job', excluded), undefined);
});

test('未完成模式先处理当前任务的后续练习，全部完成的任务直接离开', () => {
	page(`<div class="pc-header-tasks-row"><div class="pc-task pc-header-task-activity"></div><div id="exercise" class="pc-task"></div></div>
		<div class="pc-slider-menu-micro pc-menu-activity"><div id="progress" class="pc-slider-menu-status-circle-half"></div></div>
		<div id="nextMicro" class="pc-slider-menu-micro"><div class="pc-slider-menu-status-circle-half"></div></div>`);
	assert.equal(unipusNext(document, false, 'job')?.id, 'exercise');
	document.querySelector('#progress')!.className = 'pc-slider-menu-status-circle-all';
	assert.equal(unipusNext(document, false, 'job')?.id, 'nextMicro');
});

test('顺序模式遇到锁定的下一练习会暂停，不越过锁定内容', () => {
	page(`<div class="pc-header-tasks-row"><div class="pc-task pc-header-task-activity"></div>
		<div class="pc-task" aria-disabled="true"></div></div>
		<div class="pc-slider-menu-micro pc-menu-activity"></div><div class="pc-slider-menu-micro"></div>`);
	assert.equal(unipusNext(document), undefined);
});

test('提交确认弹窗、仍可提交和空页面不视为提交成功', () => {
	page('<footer id="pc-foot"><div class="question-common-course-page"><a class="btn">提 交</a></div></footer>');
	assert.equal(unipusWorkSubmitted(document), false);
	document.querySelector('.btn')!.textContent = '重新答题';
	assert.equal(unipusWorkSubmitted(document), true);
	document.body.insertAdjacentHTML('beforeend', '<div class="ant-modal-content">请确认</div>');
	assert.equal(unipusWorkSubmitted(document), false);
	page('');
	assert.equal(unipusWorkSubmitted(document), false);
});

test('切题释放 commonWork 后，旧倒计时和配置事件都不能再启动 worker', async () => {
	const { commonWork } =
		require('../packages/scripts/src/utils/work') as typeof import('../packages/scripts/src/utils/work');
	const { CommonProject } =
		require('../packages/scripts/src/projects/common') as typeof import('../packages/scripts/src/projects/common');
	const { $ui, $message } = require('easy-us');
	const settings = CommonProject.scripts.settings;
	const originalOptions = settings.methods.getWorkOptions;
	const originalPrevent = $ui.preventText;
	const originalMessage = $message.info;
	let delayedStart: (() => void) | undefined;
	let workers = 0;
	const listenersBefore = settings.listenerCount('answerer-wrapper-change');
	try {
		settings.methods.getWorkOptions = () => ({ answererWrappers: [{}] } as any);
		$ui.preventText = (options: any) => {
			delayedStart = options.ondefault;
			return document.createElement('span');
		};
		$message.info = () => undefined;
		const dispose = commonWork({
			workerProvider: () => {
				workers++;
				return undefined;
			}
		});
		assert.equal(settings.listenerCount('answerer-wrapper-change'), listenersBefore + 1);
		dispose();
		dispose();
		assert.equal(settings.listenerCount('answerer-wrapper-change'), listenersBefore);
		delayedStart!();
		settings.emit('answerer-wrapper-change', [{}] as any, []);
		assert.equal(workers, 0);

		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const disposePending = commonWork({
			beforeRunning: () => pending,
			workerProvider: () => {
				workers++;
				return undefined;
			}
		});
		delayedStart!();
		disposePending();
		release();
		await Promise.resolve();
		assert.equal(workers, 0);
		assert.equal(settings.listenerCount('answerer-wrapper-change'), listenersBefore);
	} finally {
		settings.methods.getWorkOptions = originalOptions;
		$ui.preventText = originalPrevent;
		$message.info = originalMessage;
	}
});
