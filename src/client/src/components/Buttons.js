import downloadIcon from '../icons/download.svg';
import mailIcon from '../icons/mail.svg';
import attachmentIcon from '../icons/paperclip.svg';
import trashIcon from '../icons/trash-2.svg'

function Buttons(props) {
    const download = () => {

        window.location = 'http://localhost:3001/download'
        /*
        fetch('/download', {
            method: 'GET',
            mode: 'cors'
        })
        */
    }

    const deleteFile = () => {
        fetch('/delete', {
            credentials: 'same-origin',
            method: 'GET',
            mode: 'cors',
        })
        .then(response => {
            if (response) {
                props.setDeleted(true);
                props.setSuccess(false);
            };
        });
    }

    const mail = (e) => {
        console.log(e.target.value);
        fetch(`/mail?type=${e.target.value}`, {
            credentials: 'same-origin',
            method: 'GET',
            mode: 'cors'
        })
        .then(response => {
            if (response.ok) {
                console.log('email sent');
                props.setEmailSent(true);
            } else {
                response.text().then(text => props.setMailError(text));
            }
        })
    }
    return (
        <>
            <button className="btn" onClick={ deleteFile } id="deleteBtn" disabled={ props.deleted || !props.success }>
                <img src={ trashIcon } alt="Trash can icon"/>
            </button>
            <button className="btn" onClick={ download } disabled={ !props.success }>
                <img src={ downloadIcon } alt="Download icon"/>
            </button>
            <button className="btn" onClick={ mail } value="body" disabled={ !props.success }>
                <img src={ mailIcon } alt="Mail icon"/>
            </button>
            <button className="btn" onClick={ mail } value="attachment" disabled={ !props.success }>
                <img src={ attachmentIcon } alt="Attachment icon"/>
            </button>
        </>
        
    )
}

export default Buttons;