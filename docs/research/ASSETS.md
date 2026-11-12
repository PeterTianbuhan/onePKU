# 校园卡的湖景素材

最终使用 `src/assets/campus-card-school.webp`（由生成的 1586×992 PNG 以 cwebp -q 86 转出，原 PNG 在 git 历史里），由内置 imagegen 生成，参考用户提供的本人校园卡截图中的珊瑚红湖景、倒影与石雕边纹。截图本身未加入项目。图片只承载装饰；余额、状态、有效期由真实数据渲染。无姓名、学号、照片或学生证文字。

今日页头曾用过一张从它提出来的墨稿（`weiming-ink.webp`，只有透明度）；今日页撤下后这张图也删了，在 git 历史里。

`docs/research/assets/campus-card-weiming-v1.png` 是此前生成的淡墨候选，未被界面引用，已移出应用源码。两张均为生成插画，不能当作学校官方卡面或校园实景照片。

## 最终生成提示词

```text
Use the attached screenshot ONLY as a visual design reference for the red-and-white Peking University campus card artwork, not as an edit target to reproduce a person's ID. Generate a brand new flat landscape raster BACKGROUND ASSET for the campus balance card in OnePKU desktop app. Crop/design only a single edge-to-edge 1536x960 landscape artwork, no phone screen, no interface, no mockup, no shadows, no rounded corners. Closely echo the reference card's distinctive visual vocabulary: warm white background, muted coral/cinnabar red duotone lakeside trees and Boya pagoda with a calm mirrored reflection on Weiming Lake, soft traditional cloudy print texture, and an elegant Chinese carved stone ornamental column / relief in a NARROW strip on the FAR RIGHT EDGE (last 10-12% width). Refine the school card design into a restrained, sophisticated desktop balance-card background. Preserve lots of light blank space: the entire upper-left 72% of the image is almost white with only barely visible warm cloud texture, so live dark UI balance text can be overlaid legibly. Put the red lake/trees/reflection illustration mostly along the BOTTOM 25-30%, becoming clearer toward the lower right; one small recognizable slender Boya pagoda can stand near the lower-right third just left of the carved border. Overall is mostly white, not a large flat red block. Coral red details should feel like fine offset printing / refined duotone school stationery, not photorealistic full-color, not brown/gray ink wash, no heavy distressed texture. CRITICAL: Do not include any portrait or person. Do not reproduce any name, student number, validity date, personal information, QR code, barcode, signature, university seal or logo. No text of any language anywhere, no 'student ID' label, no letters or numbers. This is decorative landscape artwork for a balance display, not a credential or fake ID. Match the reference's recognizable coral-red lake and carved-edge aesthetic while improving whitespace and visual delicacy.
```
