// Naive UI 主题覆盖：将组件库交互状态映射到 e2e_assistant 语义设计 token。
import type { GlobalThemeOverrides } from 'naive-ui'

export const naiveThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#0c703e',
    primaryColorHover: '#0c7a43',
    primaryColorPressed: '#095f35',
    primaryColorSuppl: '#0c703e',
    infoColor: '#3b82f6',
    borderRadius: '3px',
    fontFamily:
      "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    textColorBase: '#334155',
    textColor1: '#0f172a',
    textColor2: '#334155',
    textColor3: '#64748b',
    bodyColor: '#f8fafc',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    borderColor: '#e2e8f0',
  },
  Menu: {
    itemHeight: '42px',
    borderRadius: '3px',
    itemColorActive: '#e8f5ee',
    itemColorActiveHover: '#dff2e7',
    itemTextColorActive: '#0c703e',
    itemTextColorActiveHover: '#095f35',
    itemIconColorActive: '#0c703e',
    itemIconColorActiveHover: '#095f35',
    itemTextColorActiveCollapsed: '#0c703e',
    itemIconColorActiveCollapsed: '#0c703e',
  },
  Button: {
    borderRadiusTiny: '3px',
    borderRadiusSmall: '3px',
    borderRadiusMedium: '3px',
    borderRadiusLarge: '3px',
    heightTiny: '24px',
    heightSmall: '30px',
    heightMedium: '34px',
  },
  Drawer: {
    closeSize: '44px',
    closeIconSize: '18px',
  },
  Empty: {
    textColor: '#64748b',
    extraTextColor: '#64748b',
  },
  Switch: {
    railHeightMedium: '24px',
    railWidthMedium: '44px',
    buttonHeightMedium: '20px',
    buttonWidthMedium: '20px',
  },
  Input: {
    borderRadius: '3px',
    heightMedium: '34px',
    textColor: '#334155',
    placeholderColor: '#64748b',
  },
}
