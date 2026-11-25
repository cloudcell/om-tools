declare module "*.md" {
  const content: string;
  export default content;
}
declare module "*.png" {
  const src: string;   // bundled as a data-URI (esbuild loader:.png=dataurl)
  export default src;
}
