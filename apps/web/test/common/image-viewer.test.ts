/**
 * 图片查看组件的单元测试（v13）。
 *
 * 覆盖三件事：
 *   - 按地址渲染图片，并在解码成功后展示原始尺寸；
 *   - 缩放控制在边界处正确禁用（不能无限放大或缩到 0）；
 *   - 加载失败时降级为文字占位，而不是留下一张破图。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ImageViewer from '../../src/common/image/ImageViewer.vue'

/**
 * 挂载查看器并返回包装器。
 *
 * @param src - 图片地址。
 * @returns 组件包装器。
 * @throws 不抛出异常。
 */
function mountViewer(src = '/api/skills/abc123456/image?path=a.png') {
  return mount(ImageViewer, { props: { src, alt: '测试图片' } })
}

describe('ImageViewer', () => {
  it('渲染图片元素并使用传入的地址与替代文本', () => {
    const wrapper = mountViewer()
    const image = wrapper.get('img.viewer-image')

    expect(image.attributes('src')).toBe(
      '/api/skills/abc123456/image?path=a.png',
    )
    expect(image.attributes('alt')).toBe('测试图片')
  })

  it('解码成功后展示原始像素尺寸', async () => {
    const wrapper = mountViewer()

    // 浏览器环境下由真实解码触发；此处直接给出目标元素并伪造 naturalWidth/Height。
    const image = wrapper.get('img.viewer-image').element as HTMLImageElement
    Object.defineProperty(image, 'naturalWidth', {
      value: 1280,
      configurable: true,
    })
    Object.defineProperty(image, 'naturalHeight', {
      value: 720,
      configurable: true,
    })
    await wrapper.get('img.viewer-image').trigger('load')

    expect(wrapper.text()).toContain('1280 × 720')
  })

  it('初始为适应容器档位：缩小与「适应」按钮不可用', () => {
    const wrapper = mountViewer()
    const buttons = wrapper.findAll('.zoom-controls button')

    // 按钮顺序：缩小、放大、适应
    expect(buttons[0]!.attributes('disabled')).toBeDefined()
    expect(buttons[1]!.attributes('disabled')).toBeUndefined()
    expect(buttons[2]!.attributes('disabled')).toBeDefined()
  })

  it('放大到上限后放大按钮禁用，缩小可回到初始档位', async () => {
    const wrapper = mountViewer()
    const zoomInButton = wrapper.findAll('.zoom-controls button')[1]!
    const zoomOutButton = wrapper.findAll('.zoom-controls button')[0]!

    // 连续点击超过上限（4 档），验证不会越界
    for (let index = 0; index < 6; index += 1) {
      await zoomInButton.trigger('click')
    }

    expect(wrapper.get('.zoom-text').text()).toBe('400%')
    expect(zoomInButton.attributes('disabled')).toBeDefined()

    await zoomOutButton.trigger('click')
    expect(wrapper.get('.zoom-text').text()).toBe('300%')
  })

  it('「适应」按钮把缩放重置回 100%', async () => {
    const wrapper = mountViewer()
    const buttons = wrapper.findAll('.zoom-controls button')

    await buttons[1]!.trigger('click')
    expect(wrapper.get('.zoom-text').text()).toBe('200%')

    await buttons[2]!.trigger('click')
    expect(wrapper.get('.zoom-text').text()).toBe('100%')
  })

  it('加载失败时降级为文字占位', async () => {
    const wrapper = mountViewer()

    await wrapper.get('img.viewer-image').trigger('error')

    expect(wrapper.text()).toContain('无法显示这张图片')
    // 失败后不再展示图片本体，避免留下破图。
    // 断言内联 display 而非 `isVisible()`：jsdom 不做布局计算，
    // `isVisible()` 对 `display: none` 仍返回 true，用它会让这条测试失去意义。
    expect(
      (wrapper.get('img.viewer-image').element as HTMLElement).style.display,
    ).toBe('none')
  })

  it('更换地址时重置缩放与失败态', async () => {
    const wrapper = mountViewer()
    await wrapper.findAll('.zoom-controls button')[1]!.trigger('click')
    expect(wrapper.get('.zoom-text').text()).toBe('200%')

    await wrapper.setProps({ src: '/api/skills/abc123456/image?path=b.png' })

    expect(wrapper.get('.zoom-text').text()).toBe('100%')
    expect(wrapper.text()).not.toContain('无法显示这张图片')
  })
})
