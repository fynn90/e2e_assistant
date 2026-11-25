<!--
  字体图标基元（iconfont.cn 导出，font-family: aufontAll）。

  本组件是该图标库的**唯一使用出口**：库要求 class 同时写 `aufontAll` 与
  `h-icon-all-*` 两个类——前者提供字体族，后者只提供 ::before 的 content。
  漏写基础类会渲染成空白方块且**无任何控制台报错**，是最难排查的踩坑点；
  调用方只传字形名，拼接收敛在此处，结构上不可能写错。

  无障碍约定：时间线中的图标均为装饰性（语义已由旁侧文字承载），默认输出
  aria-hidden 以免被重复朗读；确需独立表意时传 `label`，转为 img 语义。
-->
<script setup lang="ts">
import { computed } from 'vue'

/*
  模板的承重设计，改动前请先确认以下三点：

  1. **模板内不得写任何注释。** 注释在模板中同样算作根节点，会使组件变成多根，
     而 Vue 对多根组件**不会做属性透传**——调用方的 `class="tool-icon"` 会被静默
     丢弃，scoped 样式随之失效。本文件曾因此踩坑，注释一律写在 script 中。
  2. 必须保持**单根空元素**。单根使父组件的 scope ID 落到该元素上，调用方的
     `.tool-icon` 等 scoped 规则才能命中。
  3. 元素内**不可有任何文本**：`.aufontAll` 的 font-family 带 !important，
     子文本会以图标字体渲染成方块；字形一律由 ::before 提供。

  本组件**有意不声明 style 块**：一旦添加 font-size 等规则，会与调用方的 scoped
  规则特异度打平，渲染结果退化为源码顺序依赖。字号走 size 内联，颜色/行高/收缩
  由调用方自行决定。
*/
const props = defineProps<{
  /** 图标字形名（不含 `h-icon-all-` 前缀），如 'earth-o'。 */
  name: string
  /**
   * 字号（px）。必填。
   *
   * 不能省略：`.aufontAll` 把 font-size 硬编码为 16px，而类规则优先于继承，
   * 图标无法从父级继承字号（现在靠继承字号的位置会静默变成 16px）。
   * 此处用内联 style 输出，内联优先级高于所有样式表规则，可稳定覆盖；
   * 也因此把「漏传字号」从静默的视觉偏差变成编译期类型错误。
   */
  size: number
  /** 可读名称。留空表示装饰性图标，对辅助技术隐藏。 */
  label?: string
}>()

/**
 * 拼接后的类名数组：基础类 + 字形类，两者缺一不可。
 * @returns 供 :class 绑定的类名数组。
 * @throws 不抛出异常。
 */
const iconClass = computed(() => ['aufontAll', `h-icon-all-${props.name}`])
</script>

<template>
  <span
    :class="iconClass"
    :style="{ fontSize: `${size}px` }"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  />
</template>
