type Shape={type?:string;enum?:unknown[];properties?:Record<string,Shape>;required?:string[];items?:Shape;minimum?:number;maximum?:number;minItems?:number;maxItems?:number;maxLength?:number;additionalProperties?:boolean};
/** Validate the small schema vocabulary declared by our tools before any file or queue mutation. */
export function validateContentToolArguments(schema:unknown,value:unknown,field="参数"):void {
  const shape=schema as Shape;
  if(shape.enum&&!shape.enum.includes(value))throw new Error(`${field}不在可选值中`);
  if(shape.type==="object"){
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`${field}需要对象`);
    const record=value as Record<string,unknown>,properties=shape.properties??{};
    for(const key of shape.required??[])if(!Object.hasOwn(record,key)||record[key]===undefined)throw new Error(`${field}.${key}为必填项`);
    for(const key of Object.keys(record)){
      if(!Object.hasOwn(properties,key)){if(shape.additionalProperties===false)throw new Error(`${field}包含不支持的字段`);continue;}
      validateContentToolArguments(properties[key],record[key],`${field}.${key}`);
    }
  }else if(shape.type==="array"){
    if(!Array.isArray(value)||shape.minItems!==undefined&&value.length<shape.minItems||shape.maxItems!==undefined&&value.length>shape.maxItems)throw new Error(`${field}需要符合数量上限的数组`);
    if(shape.items)for(const [i,item] of value.entries())validateContentToolArguments(shape.items,item,`${field}[${i}]`);
  }else if(shape.type==="string"){
    if(typeof value!=="string"||shape.maxLength!==undefined&&value.length>shape.maxLength)throw new Error(`${field}需要符合长度上限的文字`);
  }else if(shape.type==="boolean"){
    if(typeof value!=="boolean")throw new Error(`${field}需要明确的布尔值`);
  }else if(shape.type==="integer"){
    if(typeof value!=="number"||!Number.isSafeInteger(value)||shape.minimum!==undefined&&value<shape.minimum||shape.maximum!==undefined&&value>shape.maximum)throw new Error(`${field}需要范围内的整数`);
  }
}
