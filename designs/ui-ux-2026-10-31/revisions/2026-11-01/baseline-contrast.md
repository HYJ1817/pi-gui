# 对比度计算记录

新方案固定实色配对 78/78 达标；失败 0。文字要求4.5:1，焦点/唯一控件边界3:1。装饰 border-subtle 不作为唯一可操作边界，未用3:1要求衡量。透明遮罩不是文本背景，不将其与白色硬算后声称通过。

算法为WCAG相对亮度：sRGB通道≤0.04045时除12.92，否则((c+0.055)/1.055)^2.4；亮度0.2126R+0.7152G+0.0722B；对比度(L高+0.05)/(L低+0.05)。下表显示值四舍五入至两位；计算使用全精度再检查。

| 主题 | 前景 | 背景 | 比值 | 要求 |
| --- | --- | --- | ---: | ---: |
| light | text-primary | surface-canvas | 14.29 | 4.5:1 |
| light | text-primary | surface-nav | 13.30 | 4.5:1 |
| light | text-primary | surface-panel | 15.18 | 4.5:1 |
| light | text-primary | surface-input | 15.18 | 4.5:1 |
| light | text-primary | surface-code | 13.55 | 4.5:1 |
| light | text-primary | surface-hover | 12.46 | 4.5:1 |
| light | text-primary | surface-pressed | 11.32 | 4.5:1 |
| light | text-primary | surface-user | 12.92 | 4.5:1 |
| light | text-secondary | surface-canvas | 6.50 | 4.5:1 |
| light | text-secondary | surface-nav | 6.05 | 4.5:1 |
| light | text-secondary | surface-panel | 6.91 | 4.5:1 |
| light | text-secondary | surface-input | 6.91 | 4.5:1 |
| light | text-secondary | surface-code | 6.16 | 4.5:1 |
| light | text-secondary | surface-hover | 5.67 | 4.5:1 |
| light | text-secondary | surface-pressed | 5.15 | 4.5:1 |
| light | text-secondary | surface-user | 5.88 | 4.5:1 |
| light | text-muted | surface-canvas | 5.96 | 4.5:1 |
| light | text-muted | surface-nav | 5.55 | 4.5:1 |
| light | text-muted | surface-panel | 6.33 | 4.5:1 |
| light | text-muted | surface-input | 6.33 | 4.5:1 |
| light | text-muted | surface-code | 5.65 | 4.5:1 |
| light | text-muted | surface-hover | 5.20 | 4.5:1 |
| light | text-muted | surface-pressed | 4.72 | 4.5:1 |
| light | text-muted | surface-user | 5.39 | 4.5:1 |
| light | text-on-primary | primary | 12.71 | 4.5:1 |
| light | text-on-primary | primary-hover | 9.59 | 4.5:1 |
| light | text-on-primary | primary-pressed | 15.24 | 4.5:1 |
| light | accent | accent-soft | 5.46 | 4.5:1 |
| light | success | success-soft | 5.67 | 4.5:1 |
| light | warning | warning-soft | 5.88 | 4.5:1 |
| light | danger | danger-soft | 5.50 | 4.5:1 |
| light | focus | surface-input | 6.44 | 3:1 |
| light | focus | surface-panel | 6.44 | 3:1 |
| light | focus | surface-canvas | 6.06 | 3:1 |
| light | focus | surface-nav | 5.64 | 3:1 |
| light | border-control | surface-input | 3.64 | 3:1 |
| light | border-control | surface-panel | 3.64 | 3:1 |
| light | border-control | surface-canvas | 3.43 | 3:1 |
| light | border-control | surface-nav | 3.19 | 3:1 |
| dark | text-primary | surface-canvas | 14.70 | 4.5:1 |
| dark | text-primary | surface-nav | 15.30 | 4.5:1 |
| dark | text-primary | surface-panel | 13.26 | 4.5:1 |
| dark | text-primary | surface-input | 12.28 | 4.5:1 |
| dark | text-primary | surface-code | 14.73 | 4.5:1 |
| dark | text-primary | surface-hover | 10.23 | 4.5:1 |
| dark | text-primary | surface-pressed | 8.27 | 4.5:1 |
| dark | text-primary | surface-user | 11.63 | 4.5:1 |
| dark | text-secondary | surface-canvas | 8.88 | 4.5:1 |
| dark | text-secondary | surface-nav | 9.24 | 4.5:1 |
| dark | text-secondary | surface-panel | 8.01 | 4.5:1 |
| dark | text-secondary | surface-input | 7.42 | 4.5:1 |
| dark | text-secondary | surface-code | 8.89 | 4.5:1 |
| dark | text-secondary | surface-hover | 6.18 | 4.5:1 |
| dark | text-secondary | surface-pressed | 4.99 | 4.5:1 |
| dark | text-secondary | surface-user | 7.02 | 4.5:1 |
| dark | text-muted | surface-canvas | 8.19 | 4.5:1 |
| dark | text-muted | surface-nav | 8.53 | 4.5:1 |
| dark | text-muted | surface-panel | 7.39 | 4.5:1 |
| dark | text-muted | surface-input | 6.85 | 4.5:1 |
| dark | text-muted | surface-code | 8.21 | 4.5:1 |
| dark | text-muted | surface-hover | 5.70 | 4.5:1 |
| dark | text-muted | surface-pressed | 4.61 | 4.5:1 |
| dark | text-muted | surface-user | 6.48 | 4.5:1 |
| dark | text-on-primary | primary | 12.54 | 4.5:1 |
| dark | text-on-primary | primary-hover | 14.16 | 4.5:1 |
| dark | text-on-primary | primary-pressed | 10.62 | 4.5:1 |
| dark | accent | accent-soft | 5.53 | 4.5:1 |
| dark | success | success-soft | 6.94 | 4.5:1 |
| dark | warning | warning-soft | 7.18 | 4.5:1 |
| dark | danger | danger-soft | 6.78 | 4.5:1 |
| dark | focus | surface-input | 7.35 | 3:1 |
| dark | focus | surface-panel | 7.94 | 3:1 |
| dark | focus | surface-canvas | 8.80 | 3:1 |
| dark | focus | surface-nav | 9.16 | 3:1 |
| dark | border-control | surface-input | 3.80 | 3:1 |
| dark | border-control | surface-panel | 4.10 | 3:1 |
| dark | border-control | surface-canvas | 4.54 | 3:1 |
| dark | border-control | surface-nav | 4.73 | 3:1 |

本表只证明指定token配对，不证明页面实际字体抗锯齿、重叠遮挡、透明混合或第三方内容；实际截图验收仍是独立要求。
