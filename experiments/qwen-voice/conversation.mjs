// This is an application event, not a fabricated transcript of the user's speech.
// Qwen requires a user-side item before generating its first audio response.
export function greetingEvents() {
 return [
  {type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:'[应用事件：语音会话已打开] 用户已唤醒或打开语音。此事件不是用户口述内容。请自然地回应一句简短招呼，不调用任何工具，随后等待用户说话。'}]}},
  {type:'response.create'},
 ];
}
