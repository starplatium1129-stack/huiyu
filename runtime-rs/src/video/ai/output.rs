use super::*;
pub(super) fn extract(text: &str) -> Value {
    text.find('{')
        .zip(text.rfind('}'))
        .filter(|(start, end)| end > start)
        .and_then(|(start, end)| serde_json::from_str(&text[start..=end]).ok())
        .unwrap_or(Value::Null)
}
fn choice(value: &Value, allowed: &[&str], fallback: Value, trimmed: bool) -> Value {
    let value = string(value, "");
    let value = if trimmed { trim(&value) } else { &value };
    if allowed.contains(&value) {
        json!(value)
    } else {
        fallback
    }
}
pub(super) fn clean(action: &str, parsed: &Value, input: &Value) -> Value {
    match action {
        "rewrite"=>{
            let mut result=json!({"prompt":input["prompt"],"shotSize":null,"camera":input["camera"],"motion":input["motion"],"dialogue":""});
            if !parsed.is_object(){return result;}
            let prompt=string(&parsed["prompt"],"");let prompt=trim(&prompt);
            if !prompt.is_empty()&&length(prompt)<=4000{result["prompt"]=json!(prompt);}
            result["shotSize"]=choice(&parsed["shotSize"],SIZES,Value::Null,false);
            result["camera"]=choice(&parsed["camera"],CAMERAS,input["camera"].clone(),true);
            result["motion"]=choice(&parsed["motion"],MOTIONS,input["motion"].clone(),true);
            let dialogue=string(&parsed["dialogue"],"");let dialogue=trim(&dialogue);
            if !dialogue.is_empty()&&length(dialogue)<=300{result["dialogue"]=json!(dialogue);}result
        }
        "polish"=>{
            let mut result=vec![json!({"shotSize":null,"camera":null,"motion":null,"dialogue":null});list(&input["shots"]).len()];
            for item in list(&parsed["shots"]) {
                let index=number(item.get("index"));
                if !item.is_object()||!index.is_finite()||index.fract()!=0.||index<0.||index>=result.len() as f64{continue;}
                let entry=&mut result[index as usize];
                entry["shotSize"]=choice(&item["shotSize"],SIZES,Value::Null,false);
                entry["camera"]=choice(&item["camera"],CAMERAS,Value::Null,true);
                entry["motion"]=choice(&item["motion"],MOTIONS,Value::Null,true);
                if let Some(dialogue)=item.get("dialogue").filter(|v|!v.is_null()) {
                    let dialogue=text(dialogue);let dialogue=trim(&dialogue);entry["dialogue"]=if length(dialogue)<=300{json!(dialogue)}else{Value::Null};
                }
            }
            json!(result)
        }
        "dialogue"=>json!(list(&parsed["options"]).iter().filter(|item|item.is_object()).filter_map(|item|{
            let text=string(&item["text"],"");let text=trim(&text);
            (!text.is_empty()&&length(text)<=60).then(||json!({"text":text,"label":clean_string(&item["label"],12)}))
        }).take(3).collect::<Vec<_>>()),
        "review"=>json!(list(&parsed["issues"]).iter().filter(|item|item.is_object()).filter_map(|item|{
            let index=number(item.get("index"));
            if !index.is_finite()||index.fract()!=0.||index<0.||index>=list(&input["shots"]).len() as f64{return None;}
            let severity=clean_string(&item["severity"],usize::MAX);let field=clean_string(&item["field"],usize::MAX);let message=clean_string(&item["message"],120);
            if !["error","warn"].contains(&severity.as_str())||!["prompt","shotSize","camera","motion","dialogue","continuity"].contains(&field.as_str())||message.is_empty(){return None;}
            Some(json!({"index":index as usize,"severity":severity,"field":field,"message":message,"suggestion":clean_string(&item["suggestion"],120)}))
        }).collect::<Vec<_>>()),
        "script"=>json!(list(&parsed["shots"]).iter().filter(|item|item.is_object()).filter_map(|item|{
            let prompt=string(&item["prompt"],"");let prompt=trim(&prompt);if prompt.is_empty()||length(prompt)>4000{return None;}
            let duration=number(item.get("duration"));let duration=if [3.,5.,10.,15.].contains(&duration){duration as u8}else{5};
            Some(json!({"prompt":prompt,"shotSize":choice(&item["shotSize"],SIZES,Value::Null,false),"camera":choice(&item["camera"],CAMERAS,json!("still"),false),"motion":choice(&item["motion"],MOTIONS,json!("subtle"),false),"dialogue":clean_string(&item["dialogue"],300),"duration":duration}))
        }).take(20).collect::<Vec<_>>()),
        _=>unreachable!(),
    }
}
