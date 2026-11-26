import { $, OCSWorker, createDefaultQuestionResolver } from '@ocsjs/core';
import { $message, $ui, Project, Script } from 'easy-us';
import { CommonProject } from './common';
import { BackgroundProject, $console } from './background';
import { playbackRate, volume, workNotes } from '../utils/configs';
import { CommonWorkOptions, playMedia } from '../utils';
import { commonWork, createCommonAnswerer, extractTextWithImages, simplifyWorkResult } from '../utils/work';
import { createSteps } from '../utils/ui';
import {
	fillUnipusInput,
	normalizeUnipusCompletionAnswer,
	unipusMedia,
	unipusNext,
	unipusOptions,
	unipusQuestionType,
	unipusQuestions,
	unipusRequired
} from '../utils/unipus';

const courseware = /^https:\/\/ucontent\.unipus\.cn\/_explorationpc_default\/pc\.html/;

export const UnipusProject = Project.create({
	name: 'U校园 AI版',
	domains: ['uai.unipus.cn', 'ucontent.unipus.cn'],
	scripts: {
		guide: new Script({
			name: '💡 使用提示',
			namespace: 'unipus.guide',
			matches: [['课程列表', 'uai.unipus.cn/app/cmgt/']],
			configs: {
				notes: {
					defaultValue: createSteps(['进入我的课程', '选择教程并点击开始学习', '在课件页面设置学习或作业选项'])
						.outerHTML
				}
			}
		}),
		study: new Script({
			name: '🖥️ 课程学习',
			namespace: 'unipus.study',
			matches: [['教程课件', courseware]],
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'支持课件中的主音视频，以及单选、多选、填空和可输入的选词填空练习。',
						'支持普通文本框简答的答案回填，主观内容请自行检查。',
						'口语、讨论、个人经历填写及未识别的题型需要手动完成。',
						'只做必修开启后，必修状态不明确时会暂停，请查看平台的学习要求提示。'
					]).outerHTML
				},
				enableMedia: { label: '自动播放音视频', attrs: { type: 'checkbox' }, defaultValue: true },
				onlyRequired: { label: '只做必修', attrs: { type: 'checkbox' }, defaultValue: false },
				autoNext: { label: '媒体结束后自动切换', attrs: { type: 'checkbox' }, defaultValue: false },
				playbackRate,
				volume
			},
			oncomplete() {
				if (self === top) watchCourseware();
			}
		}),
		work: new Script({
			name: '✍️ 课件练习',
			namespace: 'unipus.work',
			matches: [['教程课件', courseware]],
			configs: { notes: workNotes }
		})
	}
});

function questionText(root: HTMLElement): { text: string; images: string[] } {
	const clone = root.cloneNode(true) as HTMLElement;
	clone.querySelectorAll('.scoop-input-wrapper, .scoop-wrapper').forEach((input) => input.replaceWith(' ____ '));
	clone.querySelectorAll('.question-material-banked-cloze-reply .option').forEach((option) => option.remove());
	clone
		.querySelectorAll('.question-common-abs-choice .option, .question-audio, .question-video-player, .qc-abs-word-tips')
		.forEach((el) => el.remove());
	return extractTextWithImages(clone);
}

function optionText(option: HTMLElement) {
	const clone = option.cloneNode(true) as HTMLElement;
	clone.querySelector('.caption')?.remove();
	return extractTextWithImages(clone).text.trim();
}

/** hash 更新早于 React 完成渲染，必须等待新题目，避免拿旧 DOM 搜题。 */
function contentKey(root: HTMLElement) {
	return (
		questionText(root).text +
		unipusOptions(root).map(optionText).join('\n') +
		(unipusMedia(root)?.getAttribute('src') || '')
	);
}

function watchCourseware() {
	const study = UnipusProject.scripts.study;
	let mountedRoot: HTMLElement | undefined;
	let mountedHash = '';
	let pendingHash = location.hash;
	let previousKey: string | undefined;
	let dispose: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout>;
	let required: boolean | undefined;
	let mountedRequired: boolean | undefined;

	const refresh = () => {
		const root = document.querySelector<HTMLElement>('#main-content .question-abs-question');
		const tip = document.querySelector('.task_tip');
		if (!root || (previousKey !== undefined && contentKey(root) === previousKey)) return;
		if (tip) required = unipusRequired(tip.textContent || '');
		if (mountedHash === location.hash && mountedRoot === root && mountedRequired === required) return;
		dispose?.();
		mountedRoot = root;
		mountedHash = location.hash;
		mountedRequired = required;
		previousKey = undefined;
		const hash = location.hash;
		let active = true;
		const current = () => active && location.hash === hash && root.isConnected;
		tip?.closest('.ant-modal-content')?.querySelector<HTMLElement>('.system-info-cloud-ok-button')?.click();
		if (study.cfg.onlyRequired && required !== true) {
			$message.info(required === false ? '当前内容为非必修，已跳过。' : '尚未确认必修状态，请查看平台的学习要求提示。');
			if (required === false && study.cfg.autoNext) unipusNext(document, true)?.click();
			return;
		}

		const media = unipusMedia(root);
		const managedMedia = !!media && study.cfg.enableMedia;
		const updateMedia = () => {
			if (!media || !current()) return;
			media.volume = Number(study.cfg.volume);
			media.muted = media.volume === 0;
			media.playbackRate = Number(study.cfg.playbackRate);
		};
		const ended = () => {
			const hasExercise = root.querySelector('.layout-reply-container, .question-common-abs-reply');
			if (current() && study.cfg.autoNext && !hasExercise) unipusNext(document)?.click();
		};
		if (media && managedMedia) {
			updateMedia();
			media.addEventListener('loadedmetadata', updateMedia);
			media.addEventListener('ended', ended);
			playMedia(() => (current() && study.cfg.enableMedia ? media.play() : undefined));
		}
		const disposeWork = unipusQuestionType(root)
			? commonWork({
					mount_script: UnipusProject.scripts.work,
					workerProvider: (opts) => (current() ? createWorker(root, opts, current) : undefined)
			  })
			: undefined;
		if (!media && !disposeWork) $message.info('当前课件需要手动完成。');
		dispose = () => {
			active = false;
			disposeWork?.();
			media?.removeEventListener('loadedmetadata', updateMedia);
			media?.removeEventListener('ended', ended);
			if (media && managedMedia) media.pause();
		};
	};

	const schedule = () => {
		if (pendingHash !== location.hash) {
			previousKey = mountedRoot?.isConnected ? contentKey(mountedRoot) : undefined;
			pendingHash = location.hash;
			required = undefined;
			dispose?.();
			dispose = undefined;
		}
		clearTimeout(timer);
		timer = setTimeout(refresh, 500);
	};
	const observer = new MutationObserver(schedule);
	observer.observe(document.body, { childList: true, subtree: true });
	window.addEventListener('hashchange', schedule);
	window.addEventListener('popstate', schedule);
	for (const key of ['onlyRequired', 'enableMedia'] as const) {
		study.onConfigChange(key, () => {
			dispose?.();
			mountedRoot = undefined;
			schedule();
		});
	}
	for (const key of ['volume', 'playbackRate'] as const) {
		study.onConfigChange(key, () => {
			if (study.cfg.onlyRequired && required !== true) return;
			const media = unipusMedia(document);
			if (!media) return;
			media.volume = Number(study.cfg.volume);
			media.muted = media.volume === 0;
			media.playbackRate = Number(study.cfg.playbackRate);
		});
	}
	window.addEventListener(
		'pagehide',
		() => {
			clearTimeout(timer);
			observer.disconnect();
			window.removeEventListener('hashchange', schedule);
			window.removeEventListener('popstate', schedule);
			dispose?.();
		},
		{ once: true }
	);
	schedule();
}

function createWorker(root: HTMLElement, opts: CommonWorkOptions, current: () => boolean) {
	const type = unipusQuestionType(root);
	if (!type) return undefined;
	// 听力题的正文常只有通用指令，带上教材及当前任务名称，避免不同单元命中同一缓存。
	const context = Array.from(
		document.querySelectorAll('.pc-break-crumb-text, .pc-header-tab-activity, .pc-header-task-activity')
	)
		.map((el) => el.textContent?.trim())
		.filter(Boolean)
		.join(' / ');
	const title = (questionRoot = root) => {
		const question = questionText(questionRoot);
		const directions = root.querySelector<HTMLElement>('.layout-direction-container');
		const instruction = questionRoot !== root && directions ? extractTextWithImages(directions) : undefined;
		const materialRoot = root.querySelector<HTMLElement>('.layout-material-container');
		const material = questionRoot !== root && materialRoot ? questionText(materialRoot) : undefined;
		const words =
			questionRoot !== root
				? Array.from(root.querySelectorAll('.question-material-banked-cloze-reply .option-placeholder'))
						.map((word) => word.textContent?.trim())
						.filter(Boolean)
						.join(' / ')
				: undefined;
		return {
			text: [context, instruction?.text, material?.text, words, question.text].filter(Boolean).join('\n'),
			images: [...(instruction?.images || []), ...(material?.images || []), ...question.images]
		};
	};
	CommonProject.scripts.workResults.methods.init();
	const worker = new OCSWorker({
		root: unipusQuestions(root),
		rootObserver: { enabled: true },
		elements: { title: (node) => [node as HTMLElement], options: (node) => unipusOptions(node as HTMLElement) },
		thread: opts.thread,
		answerSeparators: opts.answerSeparators.split(',').map((s) => s.trim()),
		answerer: createCommonAnswerer({
			titleTransform: (_, ctx) => title(ctx.root),
			optionsTransform: (elements, ctx) => {
				ctx.type = unipusQuestionType(ctx.root);
				return ctx.type === 'completion' ? '' : elements.options.map(optionText).join('\n');
			},
			answererWrappers: opts.answererWrappers,
			period: opts.period
		}),
		work: async (ctx) => {
			const type = unipusQuestionType(ctx.root);
			if (!type) throw new Error('当前题型尚未适配。');
			ctx.type = type;
			let infos = ctx.searchInfos;
			if (type === 'completion' && ctx.elements.options[0]?.tagName === 'TEXTAREA') {
				// 简答中的分号、编号和换行属于正文，不能被公共填空分隔符拆开。
				infos = infos.map((info) => ({
					...info,
					results: info.results.length
						? [{ ...info.results[0], answer: JSON.stringify([info.results.map((result) => result.answer).join('\n')]) }]
						: []
				}));
			}
			if (type === 'completion' && ctx.elements.options[0]?.tagName !== 'TEXTAREA') {
				const number = ctx.root.textContent?.match(/^\s*(\d+)[.)、]/)?.[1];
				infos = infos.map((info) => ({
					...info,
					results: info.results.flatMap((result) => {
						const answer = normalizeUnipusCompletionAnswer(
							result.answer,
							ctx.elements.options.length,
							number === undefined ? undefined : Number(number)
						);
						return answer === undefined ? [] : [{ ...result, answer }];
					})
				}));
			}
			const selected = new Set<HTMLElement>();
			const result = await createDefaultQuestionResolver(ctx, optionText)[type](
				infos,
				ctx.elements.options,
				async (_, answer, option) => {
					while (worker.isStop && current() && !worker.isClose) await $.sleep(200);
					if (!current() || worker.isClose) throw new Error('课件已切换，本次答题已结束。');
					if (type === 'completion') fillUnipusInput(option as HTMLInputElement | HTMLTextAreaElement, answer);
					else selected.add(option);
				}
			);
			// 先解析完整答案，再一次性同步选项，避免取消重答时留下旧的多选项。
			if (result.finish && type !== 'completion') {
				for (const option of ctx.elements.options) {
					// 单选只能选择目标项，点击旧选项不能取消它。
					if (type === 'single' && !selected.has(option)) continue;
					while (worker.isStop && current() && !worker.isClose) await $.sleep(200);
					if (!current() || worker.isClose) throw new Error('课件已切换，本次答题已结束。');
					if (option.classList.contains('selected') !== selected.has(option)) {
						option.click();
						await $.sleep(100);
					}
				}
			}
			return result;
		},
		onResultsInit: (_, __, results) => {
			if (current())
				return CommonProject.scripts.workResults.methods.fillAll(
					results.map((r, i) => simplifyWorkResult(r, (titles) => title(titles[0] || root).text, i))
				);
		},
		onResultsUpdate: (result, index) => {
			if (current())
				return CommonProject.scripts.workResults.methods.update(
					index,
					simplifyWorkResult(result, (titles) => title(titles[0] || root).text, index)
				);
		}
	});
	// 等待 commonWork 绑定暂停、关闭及结果面板事件后再启动。
	setTimeout(async () => {
		try {
			if (!current() || worker.isClose) return;
			const results = await worker.doWork({ enable_debug: BackgroundProject.scripts.dev.cfg.enable_answerer_debug });
			await $.sleep(opts.stopSecondWhenFinish * 1000);
			while (worker.isStop && current() && !worker.isClose) await $.sleep(200);
			if (!current() || worker.isClose) return;
			await worker.uploadHandler({
				results,
				type: opts.upload,
				callback: async (_, uploadable) => {
					if (!uploadable || !current() || worker.isClose) return;
					const media = unipusMedia(root);
					if (media && !media.ended) {
						$message.info('等待本页音视频播放完成后提交。');
						while (!media.ended && current() && !worker.isClose) await $.sleep(200);
					}
					while (worker.isStop && current() && !worker.isClose) await $.sleep(200);
					if (!current() || worker.isClose) return;
					const submit = document.querySelector<HTMLElement>('#pc-foot .question-common-course-page .btn');
					if (submit?.textContent?.replace(/\s/g, '') === '提交') submit.click();
				}
			});
			$message.info('本页答题完成，请检查页面结果后继续。');
		} catch (error) {
			if (current() && !worker.isClose) $console.error('U校园答题失败：' + String(error));
		} finally {
			if (!worker.isClose) worker.emit('done');
		}
	}, 0);
	worker.once('close', () => {
		worker.isClose = true;
	});
	return worker;
}
