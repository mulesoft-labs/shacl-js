function hasMaxLength($value, $customMaxLength) {
    debugger;
    if($value.isLiteral) {
        return $value.value.length <= $customMaxLength.value;
    }
    else if($value.isNamedNode) {
        return $value.value.length <= $customMaxLength.value;
    }
    else { // Blank node
        return false;
    }
}


function constantValid($focusNode, $constantValidation) {
    debugger;
    return $constantValidation.value === "true";
}
